import { getAllPosts } from '@/lib/posts';
import { PostCard } from '@/components/PostCard';
import { CATEGORIES, CATEGORY_SECTIONS, SECTIONED_CATEGORY_KEYS, getCategoryIcon } from '@/lib/categories';
import Link from 'next/link';
import { HomeSearch } from '@/components/HomeSearch';
import { CategoryStatsDashboard } from '@/components/CategoryStatsDashboard';

export default async function HomePage() {
  const posts = await getAllPosts();
  const totalCategories = Object.keys(CATEGORIES).length;
  const premiumCount = posts.filter(p => p.isPremium).length;

  return (
    <div>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative mb-10 rounded-2xl overflow-hidden bg-gradient-to-br from-[#0A1628] via-[#0D1F3C] to-[#091422] border border-[#C8A84B]/30 shadow-xl shadow-black/40">
        {/* Subtle grid texture overlay */}
        <div className="absolute inset-0 opacity-5" style={{
          backgroundImage: 'linear-gradient(#C8A84B 1px, transparent 1px), linear-gradient(90deg, #C8A84B 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }} />

        <div className="relative px-6 py-12 sm:py-16 text-center">
          <p className="text-xs font-bold text-[#C8A84B] uppercase tracking-[0.2em] mb-4">
            Penguin Orchestra
          </p>

          <h1 className="text-4xl sm:text-5xl font-extrabold mb-3 leading-tight">
            <span className="text-[#FFE4A0]">21st Century Apps DBA</span>
            <span className="block text-[#E8693C] mt-1">Concepts &amp; Solutions</span>
          </h1>

          <p className="text-[#FFCB8E] max-w-2xl mx-auto mb-6 text-base sm:text-lg leading-relaxed">
            Practical guides and deep-dives on Oracle Database, E-Business Suite, WebLogic,
            GoldenGate, Data Guard, RAC &amp; Clusterware, Exadata, and Essbase — written by
            a team of System Admins, Core DBAs, Apps DBAs, and Solution Architects.
          </p>

          {/* Stats bar */}
          <div className="flex items-center justify-center gap-6 mb-8 text-sm">
            <div className="text-center">
              <div className="text-2xl font-bold text-[#FFE4A0]">{posts.length}</div>
              <div className="text-[#C8A84B]/70 text-xs uppercase tracking-wider">Articles</div>
            </div>
            <div className="w-px h-8 bg-[#C8A84B]/30" />
            <div className="text-center">
              <div className="text-2xl font-bold text-[#FFE4A0]">{totalCategories}</div>
              <div className="text-[#C8A84B]/70 text-xs uppercase tracking-wider">Topics</div>
            </div>
            <div className="w-px h-8 bg-[#C8A84B]/30" />
            <div className="text-center">
              <div className="text-2xl font-bold text-[#FFE4A0]">Free</div>
              <div className="text-[#C8A84B]/70 text-xs uppercase tracking-wider">to Browse</div>
              <div className="text-amber-400 text-xs font-medium mt-1">
                {premiumCount} runbooks with subscription
              </div>
            </div>
          </div>

          {/* Search bar */}
          <div className="max-w-xl mx-auto">
            <HomeSearch />
          </div>
        </div>
      </section>

      <CategoryStatsDashboard posts={posts} />

      {/* ── Browse by Topic ───────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold text-[#E8693C] uppercase tracking-wider mb-4">Browse by Topic</h2>

        {/* Main categories */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Object.entries(CATEGORIES)
            .filter(([key]) => !SECTIONED_CATEGORY_KEYS.has(key))
            .map(([key, { label, color, description }]) => (
              <Link
                key={key}
                href={`/category/${key}`}
                className="group p-3 bg-[#FFF3B0] rounded-xl border border-[#C8A84B] hover:shadow-md hover:shadow-[#E8693C]/20 hover:-translate-y-0.5 transition-all duration-150 paper-texture"
              >
                <div className="text-2xl mb-2 leading-none">{getCategoryIcon(key as any)}</div>
                <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mb-1.5 ${color}`}>
                  {label}
                </span>
                <p className="text-xs text-[#4A3500] leading-tight">{description}</p>
              </Link>
            ))}
        </div>

        {/* Section groups */}
        {Object.entries(CATEGORY_SECTIONS).map(([sectionKey, section]) => (
          <div key={sectionKey} className="mt-8">
            <div className="flex items-center gap-3 mb-4">
              <span className="h-px flex-1 bg-[#C8A84B]/40" />
              <span className={`text-xs font-semibold px-3 py-0.5 rounded-full ${section.color}`}>
                {section.label}
              </span>
              <span className="h-px flex-1 bg-[#C8A84B]/40" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {section.categories.map((catKey) => {
                const { label, color, description } = CATEGORIES[catKey];
                return (
                  <Link
                    key={catKey}
                    href={`/category/${catKey}`}
                    className="group p-3 bg-[#FFF3B0] rounded-xl border border-[#C8A84B] hover:shadow-md hover:shadow-[#E8693C]/20 hover:-translate-y-0.5 transition-all duration-150 paper-texture"
                  >
                    <div className="text-2xl mb-2 leading-none">{getCategoryIcon(catKey)}</div>
                    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mb-1.5 ${color}`}>
                      {label}
                    </span>
                    <p className="text-xs text-[#4A3500] leading-tight">{description}</p>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {/* ── Featured post ─────────────────────────────────────────────── */}
      <section className="mb-6">
        <Link
          href="/posts/ebs-concurrent-program-performance-data-warehouse-python-ml"
          className="flex items-center justify-between gap-4 p-4 bg-gradient-to-r from-[#FFF3B0] to-[#FFE97A] border border-[#C8A84B] rounded-xl hover:shadow-md hover:shadow-[#E8693C]/20 transition-all group paper-texture"
        >
          <div>
            <span className="text-xs font-bold text-[#E8693C] uppercase tracking-wide">Featured</span>
            <p className="text-sm font-semibold text-[#0D1F3C] group-hover:text-[#E8693C] transition-colors mt-0.5">
              EBS Concurrent Program Performance: Building a Data Warehouse with AWR Correlation and Python ML
            </p>
          </div>
          <span className="shrink-0 text-[#E8693C] font-bold text-sm">Read →</span>
        </Link>
      </section>

      {/* ── Latest Posts ──────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#E8693C] uppercase tracking-wider">Latest Posts</h2>
          <span className="text-xs text-[#C8A84B]">{posts.length} total</span>
        </div>
        {posts.length === 0 ? (
          <p className="text-gray-500">No posts yet. Check back soon.</p>
        ) : (
          <div className="grid gap-3">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
