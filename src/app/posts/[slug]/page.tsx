import { notFound } from 'next/navigation';
import { getPostBySlug, getAllPosts } from '@/lib/posts';

const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
import { getSubscription, isActive } from '@/lib/subscriptions';
import { getCategoryLabel, getCategoryColor } from '@/lib/categories';
import { Badge } from '@/components/ui/badge';
import { YouTubeEmbed } from '@/components/YouTubeEmbed';
import { VideoPlayer } from '@/components/VideoPlayer';
import { PostContent } from '@/components/PostContent';
import { PaywallCTA } from '@/components/PaywallCTA';
import Link from 'next/link';
import type { Metadata } from 'next';
import type { CategoryKey } from '@/lib/categories';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  const posts = await getAllPosts();
  return posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.excerpt ?? undefined,
  };
}

const PREVIEW_CHARS = 3000;

function truncateContent(content: string): string {
  if (content.length <= PREVIEW_CHARS) return content;
  const preview = content.slice(0, PREVIEW_CHARS);
  const lastBreak = preview.lastIndexOf('\n\n');
  return lastBreak > 500 ? preview.slice(0, lastBreak) : preview;
}

export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) notFound();

  let userId: string | null = null;
  if (clerkEnabled) {
    const { auth } = await import('@clerk/nextjs/server');
    const result = await auth();
    userId = result.userId;
  }
  const sub = userId ? await getSubscription(userId) : null;
  const subscribed = isActive(sub);
  const isLocked = post.isPremium && !subscribed;

  const categoryKey = post.category as CategoryKey;
  const displayContent = isLocked ? truncateContent(post.content) : post.content;

  const monthlyPriceId = process.env.STRIPE_MONTHLY_PRICE_ID!;
  const yearlyPriceId = process.env.STRIPE_YEARLY_PRICE_ID!;

  return (
    <article className="max-w-3xl mx-auto">
      <div className="mb-6">
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          ← All Posts
        </Link>
      </div>

      <header className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Badge className={`border-0 text-xs font-medium ${getCategoryColor(categoryKey)}`}>
            <Link href={`/category/${categoryKey}`}>{getCategoryLabel(categoryKey)}</Link>
          </Badge>
          {post.isPremium && (
            <span className="text-xs font-medium px-2 py-0.5 rounded bg-amber-100 text-amber-800">
              Premium
            </span>
          )}
        </div>
        <h1 className="text-3xl font-bold text-gray-900 leading-tight mb-3">{post.title}</h1>
        {post.excerpt && (
          <p className="text-lg text-gray-600 leading-relaxed">{post.excerpt}</p>
        )}
        {post.publishedAt && (
          <time className="text-sm text-gray-400 mt-3 block">
            {new Date(post.publishedAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </time>
        )}
      </header>

      {post.youtubeUrl && (
        <YouTubeEmbed url={post.youtubeUrl} title={post.title} />
      )}

      {post.videoUrl && (
        <VideoPlayer url={post.videoUrl} title={post.title} />
      )}

      <div className={`bg-white rounded-xl border border-gray-200 p-6 sm:p-8 ${isLocked ? 'relative overflow-hidden' : ''}`}>
        <PostContent content={displayContent} />
      </div>

      {isLocked && (
        <PaywallCTA
          userId={userId}
          monthlyPriceId={monthlyPriceId}
          yearlyPriceId={yearlyPriceId}
        />
      )}

      <div className="mt-8 pt-6 border-t">
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          ← Back to all posts
        </Link>
      </div>
    </article>
  );
}
