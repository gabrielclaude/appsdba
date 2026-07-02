export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { getContactStats, getAllCampaigns, getCampaignAnalytics } from '@/lib/email-marketing';

export default async function EmailOverviewPage() {
  const [contactStats, campaigns, analytics] = await Promise.all([
    getContactStats(),
    getAllCampaigns(10),
    getCampaignAnalytics(),
  ]);

  const sentCampaigns = campaigns.filter((c) => c.status === 'sent');
  const avgOpenRate =
    analytics.length > 0
      ? analytics.reduce((sum, c) => sum + c.openRate, 0) / analytics.length
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Email Marketing</h1>
        <div className="flex gap-3">
          <Link
            href="/admin/email/contacts"
            className="text-sm bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 px-4 py-2 rounded-lg transition-colors"
          >
            Manage Contacts
          </Link>
          <Link
            href="/admin/email/campaigns/new"
            className="text-sm bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg transition-colors"
          >
            + New Campaign
          </Link>
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Total Contacts</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{contactStats.total.toLocaleString()}</p>
          <p className="text-xs text-gray-400">all statuses</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Subscribed</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{contactStats.subscribed.toLocaleString()}</p>
          <p className="text-xs text-gray-400">active recipients</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Campaigns Sent</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{sentCampaigns.length}</p>
          <p className="text-xs text-gray-400">total sent</p>
        </div>
        <div className="bg-white border border-orange-200 bg-orange-50 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Avg Open Rate</p>
          <p className="text-2xl font-bold text-orange-600 mt-1">{avgOpenRate.toFixed(1)}%</p>
          <p className="text-xs text-gray-400">last 20 campaigns</p>
        </div>
      </div>

      {/* Recent Campaigns table */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Recent Campaigns</h2>
          <Link href="/admin/email/campaigns" className="text-sm text-orange-600 hover:text-orange-700">
            View all →
          </Link>
        </div>
        {campaigns.length === 0 ? (
          <p className="text-sm text-gray-400">
            No campaigns yet.{' '}
            <Link href="/admin/email/campaigns/new" className="text-orange-600">
              Create one.
            </Link>
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-gray-500">Name</th>
                <th className="text-left py-2 text-gray-500">Status</th>
                <th className="text-right py-2 text-gray-500">Sent</th>
                <th className="text-right py-2 text-gray-500">Opens</th>
                <th className="text-right py-2 text-gray-500">Open Rate</th>
                <th className="text-right py-2 text-gray-500">Clicks</th>
                <th className="text-right py-2 text-gray-500">Click Rate</th>
                <th className="text-right py-2 text-gray-500">Date</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const openRate = c.totalSent > 0 ? (c.totalOpens / c.totalSent) * 100 : 0;
                const clickRate = c.totalSent > 0 ? (c.totalClicks / c.totalSent) * 100 : 0;
                const statusColors: Record<string, string> = {
                  draft: 'bg-gray-100 text-gray-600',
                  scheduled: 'bg-blue-100 text-blue-700',
                  sending: 'bg-yellow-100 text-yellow-700',
                  sent: 'bg-green-100 text-green-700',
                  canceled: 'bg-red-100 text-red-600',
                };
                return (
                  <tr key={c.id} className="border-b border-gray-50">
                    <td className="py-2">
                      <Link
                        href={`/admin/email/campaigns/${c.id}`}
                        className="font-medium text-gray-800 hover:text-orange-600"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="py-2">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusColors[c.status] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="py-2 text-right text-gray-700">{c.totalSent.toLocaleString()}</td>
                    <td className="py-2 text-right text-gray-700">{c.totalOpens.toLocaleString()}</td>
                    <td className="py-2 text-right text-gray-700">{openRate.toFixed(1)}%</td>
                    <td className="py-2 text-right text-gray-700">{c.totalClicks.toLocaleString()}</td>
                    <td className="py-2 text-right text-gray-700">{clickRate.toFixed(1)}%</td>
                    <td className="py-2 text-right text-gray-500 text-xs">
                      {c.sentAt ? new Date(c.sentAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Quick actions */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/admin/email/contacts"
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Manage Contacts
          </Link>
          <Link
            href="/admin/email/campaigns"
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            All Campaigns
          </Link>
          <Link
            href="/admin/email/campaigns/new"
            className="px-4 py-2 rounded-lg bg-orange-500 text-sm text-white hover:bg-orange-600 transition-colors"
          >
            + New Campaign
          </Link>
          <Link
            href="/admin/email/analytics"
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Analytics Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
