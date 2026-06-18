import { getAllPosts } from '@/lib/posts';
import { PostCard } from '@/components/PostCard';
import { CATEGORIES } from '@/lib/categories';
import Link from 'next/link';

export default async function HomePage() {
  const posts = await getAllPosts();

  return (
    <div>
      <section className="mb-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[#FFE4A0] mb-2">21st Century Apps DBA</h1>
            <p className="text-[#FFCB8E] max-w-2xl">
              Practical guides and deep-dives on Oracle Database, E-Business Suite, WebLogic, GoldenGate,
              Data Guard disaster recovery, Oracle RAC &amp; Clusterware, Exadata, and Essbase — written by a working DBA.
            </p>
          </div>
          <Link href="/dw" className="shrink-0 mt-1 text-sm font-medium text-[#5EEAD4] hover:text-teal-300 hover:underline transition">
            Performance DW →
          </Link>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-[#E8693C] uppercase tracking-wider mb-4">Browse by Topic</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Object.entries(CATEGORIES).map(([key, { label, color, description }]) => (
            <Link
              key={key}
              href={`/category/${key}`}
              className="group p-3 bg-[#FFF3B0] rounded-lg border border-[#C8A84B] hover:shadow-md hover:shadow-[#E8693C]/20 transition-shadow paper-texture"
            >
              <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded mb-2 ${color}`}>
                {label}
              </span>
              <p className="text-xs text-[#4A3500] leading-tight">{description}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <Link
          href="/posts/ebs-concurrent-program-performance-data-warehouse-python-ml"
          className="flex items-center justify-between gap-4 p-4 bg-[#FFF3B0] border border-[#C8A84B] rounded-lg hover:bg-[#FFE97A] transition-colors group paper-texture"
        >
          <div>
            <span className="text-xs font-medium text-[#E8693C] uppercase tracking-wide">New</span>
            <p className="text-sm font-semibold text-[#1E0E26] group-hover:text-[#E8693C] transition-colors mt-0.5">
              EBS Concurrent Program Performance: Building a Data Warehouse with AWR Correlation and Python ML
            </p>
          </div>
          <span className="shrink-0 text-[#E8693C] font-medium text-sm">Read →</span>
        </Link>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-[#E8693C] uppercase tracking-wider mb-4">
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
