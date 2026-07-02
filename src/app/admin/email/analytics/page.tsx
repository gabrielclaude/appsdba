export const dynamic = 'force-dynamic';
import { getCampaignAnalytics, getTopicAnalytics, getMonthlyEmailStats } from '@/lib/email-marketing';

export default async function EmailAnalyticsPage() {
  const [analytics, topicAnalytics, monthlyStats] = await Promise.all([
    getCampaignAnalytics(),
    getTopicAnalytics(),
    getMonthlyEmailStats(),
  ]);

  const totalSent = analytics.reduce((s, c) => s + c.totalSent, 0);
  const totalOpens = analytics.reduce((s, c) => s + c.totalOpens, 0);
  const totalClicks = analytics.reduce((s, c) => s + c.totalClicks, 0);
  const totalUnsubs = analytics.reduce((s, c) => s + c.totalUnsubscribes, 0);
  const avgOpenRate = analytics.length > 0 ? analytics.reduce((s, c) => s + c.openRate, 0) / analytics.length : 0;
  const avgClickRate = analytics.length > 0 ? analytics.reduce((s, c) => s + c.clickRate, 0) / analytics.length : 0;

  const topCampaigns = [...analytics]
    .sort((a, b) => b.openRate - a.openRate)
    .slice(0, 10);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Email Analytics</h1>

      {/* Overall metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Campaigns Sent</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{analytics.length}</p>
          <p className="text-xs text-gray-400">last 20 tracked</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Emails Delivered</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalSent.toLocaleString()}</p>
          <p className="text-xs text-gray-400">total sends</p>
        </div>
        <div className="bg-white border border-orange-200 bg-orange-50 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Avg Open Rate</p>
          <p className="text-2xl font-bold text-orange-600 mt-1">{avgOpenRate.toFixed(1)}%</p>
          <p className="text-xs text-gray-400">{totalOpens.toLocaleString()} total opens</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Avg Click Rate</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{avgClickRate.toFixed(1)}%</p>
          <p className="text-xs text-gray-400">{totalClicks.toLocaleString()} total clicks</p>
        </div>
      </div>

      {/* Performance by Topic */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Performance by Topic</h2>
        {topicAnalytics.length === 0 ? (
          <p className="text-sm text-gray-400">No topic data yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-gray-500">Category</th>
                <th className="text-right py-2 text-gray-500">Campaigns</th>
                <th className="text-right py-2 text-gray-500">Total Sent</th>
                <th className="text-right py-2 text-gray-500">Total Opens</th>
                <th className="text-right py-2 text-gray-500">Open Rate</th>
                <th className="text-right py-2 text-gray-500">Total Clicks</th>
                <th className="text-right py-2 text-gray-500">Click Rate</th>
              </tr>
            </thead>
            <tbody>
              {topicAnalytics.map((row) => (
                <tr key={row.category} className="border-b border-gray-50">
                  <td className="py-2 text-gray-800">{row.category}</td>
                  <td className="py-2 text-right text-gray-600">{Number(row.total_campaigns)}</td>
                  <td className="py-2 text-right text-gray-600">{Number(row.total_sent).toLocaleString()}</td>
                  <td className="py-2 text-right text-gray-600">{Number(row.total_opens).toLocaleString()}</td>
                  <td className="py-2 text-right font-medium text-gray-900">{Number(row.avg_open_rate).toFixed(1)}%</td>
                  <td className="py-2 text-right text-gray-600">{Number(row.total_clicks).toLocaleString()}</td>
                  <td className="py-2 text-right text-gray-600">{Number(row.avg_click_rate).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Monthly volume */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Monthly Volume (Last 6 Months)</h2>
        {monthlyStats.length === 0 ? (
          <p className="text-sm text-gray-400">No monthly data yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-gray-500">Month</th>
                <th className="text-right py-2 text-gray-500">Emails Sent</th>
                <th className="text-right py-2 text-gray-500">Opens</th>
                <th className="text-right py-2 text-gray-500">Open Rate</th>
              </tr>
            </thead>
            <tbody>
              {monthlyStats.map((row) => {
                const openRate = row.sent_count > 0 ? (row.open_count / row.sent_count) * 100 : 0;
                return (
                  <tr key={row.month} className="border-b border-gray-50">
                    <td className="py-2 text-gray-700">{row.month}</td>
                    <td className="py-2 text-right text-gray-600">{row.sent_count.toLocaleString()}</td>
                    <td className="py-2 text-right text-gray-600">{row.open_count.toLocaleString()}</td>
                    <td className="py-2 text-right font-medium text-gray-900">{openRate.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Best performing campaigns */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Best Performing Campaigns (Top 10 by Open Rate)</h2>
        {topCampaigns.length === 0 ? (
          <p className="text-sm text-gray-400">No sent campaigns yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-gray-500">Campaign</th>
                <th className="text-left py-2 text-gray-500">Subject</th>
                <th className="text-left py-2 text-gray-500">Sent Date</th>
                <th className="text-right py-2 text-gray-500">Recipients</th>
                <th className="text-right py-2 text-gray-500">Open Rate</th>
                <th className="text-right py-2 text-gray-500">Click Rate</th>
                <th className="text-right py-2 text-gray-500">Unsub Rate</th>
              </tr>
            </thead>
            <tbody>
              {topCampaigns.map((c) => (
                <tr key={c.id} className="border-b border-gray-50">
                  <td className="py-2 font-medium text-gray-800">{c.name}</td>
                  <td className="py-2 text-gray-600 max-w-xs">
                    <span title={c.subject}>
                      {c.subject.length > 35 ? c.subject.slice(0, 35) + '…' : c.subject}
                    </span>
                  </td>
                  <td className="py-2 text-gray-400 text-xs">
                    {c.sentAt ? new Date(c.sentAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-2 text-right text-gray-600">{c.totalSent.toLocaleString()}</td>
                  <td className="py-2 text-right font-medium text-green-700">{c.openRate.toFixed(1)}%</td>
                  <td className="py-2 text-right text-gray-700">{c.clickRate.toFixed(1)}%</td>
                  <td className="py-2 text-right text-gray-700">{c.unsubscribeRate.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Engagement funnel */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Engagement Funnel</h2>
        <div className="flex flex-wrap gap-4">
          {[
            { label: 'Sent', value: totalSent, pct: 100, color: 'bg-blue-500' },
            {
              label: 'Opened',
              value: totalOpens,
              pct: totalSent > 0 ? (totalOpens / totalSent) * 100 : 0,
              color: 'bg-orange-500',
            },
            {
              label: 'Clicked',
              value: totalClicks,
              pct: totalOpens > 0 ? (totalClicks / totalOpens) * 100 : 0,
              color: 'bg-green-500',
            },
            {
              label: 'Unsubscribed',
              value: totalUnsubs,
              pct: totalSent > 0 ? (totalUnsubs / totalSent) * 100 : 0,
              color: 'bg-red-400',
            },
          ].map((step) => (
            <div key={step.label} className="flex-1 min-w-[120px] text-center p-4 rounded-xl border border-gray-100">
              <div className={`w-3 h-3 rounded-full ${step.color} mx-auto mb-2`} />
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{step.label}</p>
              <p className="text-xl font-bold text-gray-900 mt-1">{step.value.toLocaleString()}</p>
              <p className="text-xs text-gray-400">{step.pct.toFixed(1)}% of prev step</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
