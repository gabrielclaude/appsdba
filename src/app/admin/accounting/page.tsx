export const dynamic = 'force-dynamic';
import Stripe from 'stripe';
import { getExpenseStats, getRecentExpenses } from '@/lib/admin';
import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';

async function getStripeRevenue() {
  if (!process.env.STRIPE_SECRET_KEY) return { charges: [], totalYTD: 0, totalThisMonth: 0 };
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const now = new Date();
  const startOfYear = Math.floor(new Date(now.getFullYear(), 0, 1).getTime() / 1000);
  const startOfMonth = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  try {
    const charges = await stripe.charges.list({ limit: 100, created: { gte: startOfYear } });
    const paid = charges.data.filter(c => c.paid && !c.refunded);
    const totalYTD = paid.reduce((sum, c) => sum + c.amount, 0);
    const totalThisMonth = paid.filter(c => c.created >= startOfMonth).reduce((sum, c) => sum + c.amount, 0);

    // Group by month for chart
    const byMonth: Record<string, number> = {};
    for (const charge of paid) {
      const d = new Date(charge.created * 1000);
      const key = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
      byMonth[key] = (byMonth[key] ?? 0) + charge.amount;
    }

    return { charges: paid.slice(0, 20), totalYTD, totalThisMonth, byMonth };
  } catch {
    return { charges: [], totalYTD: 0, totalThisMonth: 0, byMonth: {} };
  }
}

export default async function AccountingPage() {
  const [stripeData, expStats, recentExpenses] = await Promise.all([
    getStripeRevenue(),
    getExpenseStats(),
    getRecentExpenses(10),
  ]);

  const revenueYTD = stripeData.totalYTD / 100;
  const revenueThisMonth = stripeData.totalThisMonth / 100;
  const expensesYTD = expStats.thisYear / 100;
  const expensesThisMonth = expStats.thisMonth / 100;
  const netYTD = revenueYTD - expensesYTD;
  const netThisMonth = revenueThisMonth - expensesThisMonth;

  // Estimate MRR from active subs
  const activeSubs = await db.select().from(subscriptions).where(eq(subscriptions.status, 'active'));
  const monthlyPriceId = process.env.STRIPE_MONTHLY_PRICE_ID;
  const yearlyPriceId = process.env.STRIPE_YEARLY_PRICE_ID;
  // Rough MRR estimate: $29 monthly, $199/12 annual
  let mrr = 0;
  for (const sub of activeSubs) {
    if (sub.stripePriceId === monthlyPriceId) mrr += 29;
    else if (sub.stripePriceId === yearlyPriceId) mrr += Math.round(199 / 12);
    else mrr += 29;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Accounting</h1>
        <Link href="/admin/expenses" className="text-sm bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg">
          + Add Expense
        </Link>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'MRR', value: `$${mrr.toLocaleString()}`, sub: 'Monthly recurring', accent: true },
          { label: 'ARR', value: `$${(mrr * 12).toLocaleString()}`, sub: 'Annual run rate' },
          { label: 'Revenue YTD', value: `$${revenueYTD.toFixed(2)}`, sub: 'Stripe charges' },
          { label: 'Revenue This Month', value: `$${revenueThisMonth.toFixed(2)}`, sub: 'Stripe charges' },
          { label: 'Expenses YTD', value: `$${expensesYTD.toFixed(2)}`, sub: 'Manual entries' },
          { label: 'Expenses (Month)', value: `$${expensesThisMonth.toFixed(2)}`, sub: 'Manual entries' },
          { label: 'Net Revenue YTD', value: `$${netYTD.toFixed(2)}`, sub: 'Revenue – Expenses', accent: netYTD > 0 },
          { label: 'Net This Month', value: `$${netThisMonth.toFixed(2)}`, sub: 'Revenue – Expenses', accent: netThisMonth > 0 },
        ].map((card) => (
          <div key={card.label} className={`bg-white border rounded-xl p-4 ${card.accent ? 'border-orange-200 bg-orange-50' : 'border-gray-200'}`}>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{card.label}</p>
            <p className={`text-2xl font-bold mt-1 ${card.accent ? 'text-orange-600' : 'text-gray-900'}`}>{card.value}</p>
            {card.sub && <p className="text-xs text-gray-400">{card.sub}</p>}
          </div>
        ))}
      </div>

      {/* Revenue by month */}
      {stripeData.byMonth && Object.keys(stripeData.byMonth).length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Revenue by Month (YTD)</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-gray-500">Month</th>
                <th className="text-right py-2 text-gray-500">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(stripeData.byMonth ?? {}).map(([month, amount]) => (
                <tr key={month} className="border-b border-gray-50">
                  <td className="py-2 text-gray-700">{month}</td>
                  <td className="py-2 text-right font-medium text-gray-900">${(amount / 100).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Expenses by category */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Expenses by Category (YTD)</h2>
          <Link href="/admin/expenses" className="text-sm text-orange-600 hover:text-orange-700">View all →</Link>
        </div>
        {expStats.byCategory.length === 0 ? (
          <p className="text-sm text-gray-400">No expenses recorded yet. <Link href="/admin/expenses" className="text-orange-600">Add one.</Link></p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-gray-500">Category</th>
                <th className="text-right py-2 text-gray-500">Total</th>
              </tr>
            </thead>
            <tbody>
              {expStats.byCategory.map((row) => (
                <tr key={row.category} className="border-b border-gray-50">
                  <td className="py-2 text-gray-700 capitalize">{row.category}</td>
                  <td className="py-2 text-right font-medium text-gray-900">${(Number(row.total) / 100).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent Stripe charges */}
      {stripeData.charges.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Stripe Charges</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-gray-500">Date</th>
                <th className="text-left py-2 text-gray-500">Description</th>
                <th className="text-right py-2 text-gray-500">Amount</th>
              </tr>
            </thead>
            <tbody>
              {stripeData.charges.map((charge) => (
                <tr key={charge.id} className="border-b border-gray-50">
                  <td className="py-2 text-gray-500 text-xs">{new Date(charge.created * 1000).toLocaleDateString()}</td>
                  <td className="py-2 text-gray-700">{charge.description ?? charge.billing_details?.email ?? charge.id}</td>
                  <td className="py-2 text-right font-medium text-green-700">${(charge.amount / 100).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
