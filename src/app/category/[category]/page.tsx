import { notFound } from 'next/navigation';
import { getPostsByCategory } from '@/lib/posts';
import { CATEGORIES, getCategoryLabel } from '@/lib/categories';
import { PostCard } from '@/components/PostCard';
import { classifyPost } from '@/lib/classify';
import Link from 'next/link';
import type { Metadata } from 'next';
import type { CategoryKey } from '@/lib/categories';

interface Props {
  params: Promise<{ category: string }>;
}

export function generateStaticParams() {
  return Object.keys(CATEGORIES).map((category) => ({ category }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { category } = await params;
  if (!(category in CATEGORIES)) return {};
  const label = getCategoryLabel(category as CategoryKey);
  return {
    title: label,
    description: CATEGORIES[category as CategoryKey].description,
  };
}

export default async function CategoryPage({ params }: Props) {
  const { category } = await params;
  if (!(category in CATEGORIES)) notFound();

  const categoryKey = category as CategoryKey;
  const posts = await getPostsByCategory(categoryKey);
  const { label, description, color } = CATEGORIES[categoryKey];

  const concepts = posts.filter(p => classifyPost(p.slug, p.title, p.category) === 'concept');
  const problemSolutions = posts.filter(p => classifyPost(p.slug, p.title, p.category) === 'problem-solution');

  return (
    <div>
      <div className="mb-6">
        <Link href="/" className="text-sm text-[#FF8C42] hover:text-[#FFE4A0] hover:underline transition-colors">
          ← All Posts
        </Link>
      </div>

      <header className="mb-8">
        <span className={`inline-block text-sm font-medium px-3 py-1 rounded-full mb-3 ${color}`}>
          {label}
        </span>
        <h1 className="text-2xl font-bold text-[#FFE4A0] mb-2">{label}</h1>
        <p className="text-[#FFCB8E]">{description}</p>
      </header>

      {posts.length === 0 ? (
        <p className="text-[#FFCB8E]">No posts in this category yet.</p>
      ) : (
        <>
          {concepts.length > 0 && (
            <section className="mb-10">
              <div className="flex items-center gap-3 mb-5">
                <h2 className="text-xl font-bold text-white px-4 py-1.5 rounded-lg bg-[#E8693C]">
                  Concepts
                </h2>
                <span className="text-sm text-[#FFCB8E]">{concepts.length} {concepts.length === 1 ? 'post' : 'posts'}</span>
              </div>
              <div className="grid gap-4">
                {concepts.map((post) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
            </section>
          )}

          {problemSolutions.length > 0 && (
            <section className="mb-10">
              <div className="flex items-center gap-3 mb-5">
                <h2 className="text-xl font-bold text-white px-4 py-1.5 rounded-lg bg-emerald-600">
                  Problems &amp; Solutions
                </h2>
                <span className="text-sm text-[#FFCB8E]">{problemSolutions.length} {problemSolutions.length === 1 ? 'post' : 'posts'}</span>
              </div>
              <div className="grid gap-4">
                {problemSolutions.map((post) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
