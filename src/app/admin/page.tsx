export const dynamic = 'force-dynamic';
import { getSubscriberStats, getExpenseStats } from '@/lib/admin';
import Link from 'next/link';

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`bg-white border rounded-xl p-5 ${accent ? 'border-orange-200 bg-orange-50' : 'border-gray-200'}`}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-3xl font-bold ${accent ? 'text-orange-600' : 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

export default async function AdminPage() {
  const [subStats, expStats] = await Promise.all([getSubscriberStats(), getExpenseStats()]);

  // Estimate MRR: $29/month per active subscriber (adjust based on actual price)
  const estimatedMRR = subStats.activeSubscribers * 29;
  const netRevenue = estimatedMRR - expStats.thisMonth / 100;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
        <p className="text-sm text-blue-200 mt-1">AppsDBA Operations Overview</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Active Subscribers" value={subStats.activeSubscribers.toString()} sub="Paying users" accent />
        <StatCard label="New This Month" value={subStats.newThisMonth.toString()} sub={`vs ${subStats.newLastMonth} last month`} />
        <StatCard label="Churned This Month" value={subStats.canceledThisMonth.toString()} />
        <StatCard label="Total Users" value={subStats.totalUsers.toString()} sub="All registered" />
        <StatCard label="Est. MRR" value={`$${estimatedMRR.toLocaleString()}`} sub="Based on active subs" accent />
        <StatCard label="Expenses (Month)" value={`$${(expStats.thisMonth / 100).toFixed(2)}`} sub={`$${(expStats.thisYear / 100).toFixed(2)} YTD`} />
        <StatCard label="Est. Net Revenue" value={`$${netRevenue.toFixed(2)}`} sub="MRR minus monthly expenses" accent={netRevenue > 0} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { href: '/admin/marketing', label: 'Marketing Dashboard', desc: 'Growth & conversion metrics' },
          { href: '/admin/accounting', label: 'Accounting', desc: 'Revenue & P&L' },
          { href: '/admin/expenses', label: 'Expenses', desc: 'Add & manage expenses' },
          { href: '/admin/users', label: 'Users', desc: 'Manage roles & subscriptions' },
        ].map((item) => (
          <Link key={item.href} href={item.href} className="bg-white border border-gray-200 rounded-xl p-4 hover:border-orange-300 hover:bg-orange-50 transition-colors">
            <p className="font-semibold text-gray-900 text-sm">{item.label}</p>
            <p className="text-xs text-gray-500 mt-1">{item.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
