import { notFound } from 'next/navigation';
import { getPostBySlug, getAllPosts } from '@/lib/posts';
import { getCategoryLabel, getCategoryColor } from '@/lib/categories';
import { Badge } from '@/components/ui/badge';
import { YouTubeEmbed } from '@/components/YouTubeEmbed';
import { PostContent } from '@/components/PostContent';
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

export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) notFound();

  const categoryKey = post.category as CategoryKey;

  return (
    <article className="max-w-3xl mx-auto">
      <div className="mb-6">
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          ← All Posts
        </Link>
      </div>

      <header className="mb-8">
        <Badge className={`mb-3 border-0 text-xs font-medium ${getCategoryColor(categoryKey)}`}>
          <Link href={`/category/${categoryKey}`}>{getCategoryLabel(categoryKey)}</Link>
        </Badge>
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

      <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8">
        <PostContent content={post.content} />
      </div>

      <div className="mt-8 pt-6 border-t">
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          ← Back to all posts
        </Link>
      </div>
    </article>
  );
}
