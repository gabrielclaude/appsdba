import { getAllPosts } from '@/lib/posts';
import { PostCard } from '@/components/PostCard';
import { CATEGORIES } from '@/lib/categories';
import Link from 'next/link';

export default async function HomePage() {
  const posts = await getAllPosts();

  return (
    <div>
      <section className="mb-10">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">21st Century Apps DBA</h1>
        <p className="text-gray-600 max-w-2xl">
          Practical guides and deep-dives on Oracle Database, E-Business Suite, WebLogic, GoldenGate,
          Data Guard disaster recovery, Oracle RAC &amp; Clusterware, Exadata, and Essbase — written by a working DBA.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">Browse by Topic</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Object.entries(CATEGORIES).map(([key, { label, color, description }]) => (
            <Link
              key={key}
              href={`/category/${key}`}
              className="group p-3 bg-white rounded-lg border border-gray-200 hover:shadow-md transition-shadow"
            >
              <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded mb-2 ${color}`}>
                {label}
              </span>
              <p className="text-xs text-gray-500 leading-tight">{description}</p>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
          Latest Posts
        </h2>
        {posts.length === 0 ? (
          <p className="text-gray-500">No posts yet. Check back soon.</p>
        ) : (
          <div className="grid gap-4">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
