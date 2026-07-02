export const dynamic = 'force-dynamic';
import { db } from '@/db';
import { subscriptions, users } from '@/db/schema';
import { desc, gte, eq, and, sql, count } from 'drizzle-orm';

export default async function MarketingPage() {
  const now = new Date();

  // Last 6 months of signups by month
  const recentSubs = await db
    .select()
    .from(subscriptions)
    .where(gte(subscriptions.createdAt, new Date(now.getFullYear(), now.getMonth() - 5, 1)))
    .orderBy(desc(subscriptions.createdAt));

  // Group by month
  const monthlyMap: Record<string, { new: number; canceled: number }> = {};
  for (const sub of recentSubs) {
    const key = sub.createdAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
    if (!monthlyMap[key]) monthlyMap[key] = { new: 0, canceled: 0 };
    if (sub.status === 'active') monthlyMap[key].new++;
    if (sub.status === 'canceled') monthlyMap[key].canceled++;
  }

  // Active subs by price (monthly vs annual)
  const monthlyPriceId = process.env.STRIPE_MONTHLY_PRICE_ID;
  const yearlyPriceId = process.env.STRIPE_YEARLY_PRICE_ID;
  const allActiveSubs = await db.select().from(subscriptions).where(eq(subscriptions.status, 'active'));
  const monthlyCount = allActiveSubs.filter(s => s.stripePriceId === monthlyPriceId).length;
  const annualCount = allActiveSubs.filter(s => s.stripePriceId === yearlyPriceId).length;
  const unknownCount = allActiveSubs.length - monthlyCount - annualCount;

  // Recent signups
  const recentUsers = await db.select().from(users).orderBy(desc(users.createdAt)).limit(10);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Marketing Dashboard</h1>

      {/* Plan breakdown */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Active Subscribers by Plan</h2>
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-4 bg-blue-50 rounded-lg">
            <p className="text-2xl font-bold text-blue-700">{monthlyCount}</p>
            <p className="text-xs text-gray-500 mt-1">Monthly</p>
          </div>
          <div className="text-center p-4 bg-green-50 rounded-lg">
            <p className="text-2xl font-bold text-green-700">{annualCount}</p>
            <p className="text-xs text-gray-500 mt-1">Annual</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <p className="text-2xl font-bold text-gray-700">{unknownCount}</p>
            <p className="text-xs text-gray-500 mt-1">Other</p>
          </div>
        </div>
      </div>

      {/* Monthly growth table */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Monthly Subscriber Growth</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-2 text-gray-500 font-medium">Month</th>
              <th className="text-right py-2 text-gray-500 font-medium">New</th>
              <th className="text-right py-2 text-gray-500 font-medium">Canceled</th>
              <th className="text-right py-2 text-gray-500 font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(monthlyMap).reverse().map(([month, data]) => (
              <tr key={month} className="border-b border-gray-50">
                <td className="py-2 text-gray-700">{month}</td>
                <td className="py-2 text-right text-green-600">+{data.new}</td>
                <td className="py-2 text-right text-red-500">-{data.canceled}</td>
                <td className="py-2 text-right font-medium text-gray-900">{data.new - data.canceled}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recent sign-ups */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Sign-ups</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-2 text-gray-500 font-medium">Name</th>
              <th className="text-left py-2 text-gray-500 font-medium">Email</th>
              <th className="text-right py-2 text-gray-500 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {recentUsers.map((u) => (
              <tr key={u.id} className="border-b border-gray-50">
                <td className="py-2 text-gray-700">{u.firstName} {u.lastName}</td>
                <td className="py-2 text-gray-600">{u.email}</td>
                <td className="py-2 text-right text-gray-400">
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
