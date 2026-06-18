import { notFound } from 'next/navigation';
import { getPostsByCategory } from '@/lib/posts';
import { CATEGORIES, getCategoryLabel } from '@/lib/categories';
import { PostCard } from '@/components/PostCard';
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
        <div className="grid gap-4">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}
