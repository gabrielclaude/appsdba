import Link from 'next/link';
import { CATEGORIES, getCategoryColor } from '@/lib/categories';
import type { CategoryKey } from '@/lib/categories';

type PostSlice = { slug: string; category: string };

interface CategoryStat {
  key: string;
  label: string;
  color: string;
  blogs: number;
  runbooks: number;
  total: number;
}

export function CategoryStatsDashboard({ posts }: { posts: PostSlice[] }) {
  const statMap = new Map<string, { blogs: number; runbooks: number }>();

  for (const post of posts) {
    const isRunbook = post.slug.endsWith('-runbook');
    const existing = statMap.get(post.category) ?? { blogs: 0, runbooks: 0 };
    statMap.set(post.category, {
      blogs: existing.blogs + (isRunbook ? 0 : 1),
      runbooks: existing.runbooks + (isRunbook ? 1 : 0),
    });
  }

  const stats: CategoryStat[] = [];
  for (const [key, counts] of statMap) {
    const cat = CATEGORIES[key as CategoryKey];
    stats.push({
      key,
      label: cat?.label ?? key,
      color: cat ? getCategoryColor(key as CategoryKey) : 'bg-gray-100 text-gray-800',
      blogs: counts.blogs,
      runbooks: counts.runbooks,
      total: counts.blogs + counts.runbooks,
    });
  }
  stats.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));

  const totalBlogs = stats.reduce((s, r) => s + r.blogs, 0);
  const totalRunbooks = stats.reduce((s, r) => s + r.runbooks, 0);
  const grandTotal = totalBlogs + totalRunbooks;

  return (
    <div className="mb-8 bg-[#FFF3B0] border border-[#C8A84B] rounded-lg paper-texture overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-[#F5E08B] border-b border-[#C8A84B] flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[#E8693C] uppercase tracking-wider">Library Stats</h2>
        <div className="flex gap-4 text-sm text-[#4A3500]">
          <span>
            <span className="font-bold text-[#0D1F3C]">{totalBlogs}</span>{' '}blog posts
          </span>
          <span>
            <span className="font-bold text-[#0D1F3C]">{totalRunbooks}</span>{' '}runbooks
          </span>
          <span>
            <span className="font-bold text-[#E8693C]">{grandTotal}</span>{' '}total
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-[#FAF0C0] border-b border-[#C8A84B]">
              <th className="px-4 py-2 text-left text-xs font-semibold text-[#6B4F1A] uppercase tracking-wide">
                Category
              </th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-[#6B4F1A] uppercase tracking-wide w-24">
                Posts
              </th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-[#6B4F1A] uppercase tracking-wide w-24">
                Runbooks
              </th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-[#6B4F1A] uppercase tracking-wide w-20">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.map((stat, i) => (
              <tr
                key={stat.key}
                className={`border-b border-[#E8D98A] hover:bg-[#FFF8D0] transition-colors ${
                  i % 2 === 1 ? 'bg-[#FFFAE8]' : ''
                }`}
              >
                <td className="px-4 py-1.5">
                  <Link href={`/category/${stat.key}`} className="hover:underline">
                    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded ${stat.color}`}>
                      {stat.label}
                    </span>
                  </Link>
                </td>
                <td className="px-4 py-1.5 text-right font-mono text-[#0D1F3C]">
                  {stat.blogs > 0 ? stat.blogs : <span className="text-[#C8A84B]">—</span>}
                </td>
                <td className="px-4 py-1.5 text-right font-mono text-[#0D1F3C]">
                  {stat.runbooks > 0 ? stat.runbooks : <span className="text-[#C8A84B]">—</span>}
                </td>
                <td className="px-4 py-1.5 text-right font-mono font-semibold text-[#E8693C]">
                  {stat.total}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[#F5E08B] border-t-2 border-[#C8A84B]">
              <td className="px-4 py-2 text-xs font-bold text-[#4A3500] uppercase tracking-wide">
                Total — {stats.length} categories
              </td>
              <td className="px-4 py-2 text-right font-mono font-bold text-[#0D1F3C]">{totalBlogs}</td>
              <td className="px-4 py-2 text-right font-mono font-bold text-[#0D1F3C]">{totalRunbooks}</td>
              <td className="px-4 py-2 text-right font-mono font-bold text-[#E8693C]">{grandTotal}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
