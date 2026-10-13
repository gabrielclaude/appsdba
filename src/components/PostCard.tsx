import Link from 'next/link';
import { getCategoryLabel, getCategoryColor, getCategoryIcon } from '@/lib/categories';
import type { Post } from '@/db/schema';
import type { CategoryKey } from '@/lib/categories';

interface PostCardProps {
  post: Post;
}

function getAuthorName(content: string): string {
  const match = content.match(/^By ([^\n]+)/);
  return match ? match[1].trim() : '';
}

function getAuthorInitials(name: string): string {
  if (!name) return 'AU';
  const parts = name.trim().split(/\s+/);
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('');
}

function getReadingTime(content: string): number {
  const text = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*`\[\]]/g, '');
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// Cycle through warm accent colours for author badges
const BADGE_COLOURS = [
  'bg-[#E8693C] text-white',
  'bg-[#C8A84B] text-[#0D1F3C]',
  'bg-[#1a4480] text-white',
  'bg-emerald-600 text-white',
  'bg-purple-600 text-white',
];

function badgeColour(initials: string): string {
  const code = (initials.charCodeAt(0) ?? 0) + (initials.charCodeAt(1) ?? 0);
  return BADGE_COLOURS[code % BADGE_COLOURS.length];
}

export function PostCard({ post }: PostCardProps) {
  const categoryKey = post.category as CategoryKey;
  const authorName = getAuthorName(post.content);
  const initials = getAuthorInitials(authorName);
  const readMins = getReadingTime(post.content);
  const icon = getCategoryIcon(categoryKey);

  return (
    <div className="group relative flex bg-[#FFF3B0] rounded-xl border border-[#C8A84B] hover:shadow-lg hover:shadow-[#E8693C]/15 transition-all duration-200 overflow-hidden paper-texture">
      {/* Left accent bar */}
      <div className="w-1 shrink-0 bg-[#E8693C] rounded-l-xl" />

      <div className="flex-1 p-4">
        {/* Top row: category badge + meta pills */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5">
            <span className="text-base leading-none">{icon}</span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${getCategoryColor(categoryKey)}`}>
              {getCategoryLabel(categoryKey)}
            </span>
            {post.isPremium && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                PRO
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-[#6B4F1A]">
            <span>{readMins} min read</span>
            {post.publishedAt && (
              <>
                <span className="text-[#C8A84B]">·</span>
                <time>
                  {new Date(post.publishedAt).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </time>
              </>
            )}
          </div>
        </div>

        {/* Title */}
        <Link href={`/posts/${post.slug}`} className="block mb-2">
          <h2 className="text-lg font-semibold text-[#0D1F3C] group-hover:text-[#E8693C] transition-colors leading-snug">
            {post.title}
          </h2>
        </Link>

        {/* Excerpt */}
        {post.excerpt && (
          <p className="text-sm text-[#4A3500] leading-relaxed mb-3 line-clamp-2">{post.excerpt}</p>
        )}

        {/* Bottom row: author + video badge */}
        <div className="flex items-center justify-between mt-2">
          {authorName ? (
            <div className="flex items-center gap-2">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${badgeColour(initials)}`}>
                {initials}
              </span>
              <span className="text-xs text-[#6B4F1A] font-medium">{authorName}</span>
            </div>
          ) : <span />}
          {post.youtubeUrl && (
            <span className="text-xs text-red-500 font-medium flex items-center gap-1">
              ▶ Video
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
