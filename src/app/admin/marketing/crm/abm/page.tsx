export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { getAccountsView, getStage, getSegment, ABM_VERTICALS, ABM_SEGMENTS } from '@/lib/crm';

export default async function AbmAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ vertical?: string; segment?: string }>;
}) {
  const { vertical, segment } = await searchParams;
  const accounts = await getAccountsView(vertical);

  const filtered = segment
    ? accounts.filter((a) => a.segments.includes(segment))
    : accounts;

  const totalContacts = filtered.reduce((n, a) => n + a.count, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/admin/marketing/crm" className="text-sm text-gray-400 hover:text-orange-600">
              ← Pipeline
            </Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm font-semibold text-gray-700">Target Accounts</span>
          </div>
          <p className="text-xs text-gray-400">
            {filtered.length} accounts · {totalContacts} contacts
          </p>
        </div>
        <Link
          href="/admin/marketing/crm"
          className="text-sm text-orange-600 hover:underline"
        >
          Back to pipeline view
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        {/* Vertical filter */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-gray-400 mr-1">Vertical:</span>
          <Link
            href={segment ? `/admin/marketing/crm/abm?segment=${segment}` : '/admin/marketing/crm/abm'}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              !vertical ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-gray-600 border-gray-200 hover:border-orange-300'
            }`}
          >
            All
          </Link>
          {ABM_VERTICALS.map((v) => {
            const params = new URLSearchParams();
            params.set('vertical', v.key);
            if (segment) params.set('segment', segment);
            return (
              <Link
                key={v.key}
                href={`/admin/marketing/crm/abm?${params.toString()}`}
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                  vertical === v.key
                    ? 'bg-orange-500 text-white border-orange-500'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-orange-300'
                }`}
              >
                {v.label}
              </Link>
            );
          })}
        </div>

        {/* Segment filter */}
        <div className="flex items-center gap-1 flex-wrap mt-1">
          <span className="text-xs text-gray-400 mr-1">Persona:</span>
          <Link
            href={vertical ? `/admin/marketing/crm/abm?vertical=${vertical}` : '/admin/marketing/crm/abm'}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              !segment ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            All
          </Link>
          {ABM_SEGMENTS.map((s) => {
            const params = new URLSearchParams();
            params.set('segment', s.key);
            if (vertical) params.set('vertical', vertical);
            return (
              <Link
                key={s.key}
                href={`/admin/marketing/crm/abm?${params.toString()}`}
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                  segment === s.key
                    ? `${s.color} border-current`
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                }`}
              >
                {s.label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Accounts table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <p className="px-6 py-10 text-sm text-gray-400 text-center">
            No accounts match the selected filters.{' '}
            <Link href="/admin/marketing/crm/abm" className="text-orange-600 hover:underline">Clear filters</Link>
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs text-gray-400 uppercase tracking-wide">
                <th className="px-6 py-3 text-left font-medium">Company</th>
                <th className="px-6 py-3 text-left font-medium">Contacts</th>
                <th className="px-6 py-3 text-left font-medium">Personas</th>
                <th className="px-6 py-3 text-left font-medium">Top Stage</th>
                <th className="px-6 py-3 text-left font-medium">Score</th>
                <th className="px-6 py-3 text-left font-medium">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map((account) => {
                const topStage = account.stages.includes('converted')
                  ? 'converted'
                  : account.stages.includes('trial')
                  ? 'trial'
                  : account.stages.includes('interested')
                  ? 'interested'
                  : account.stages.includes('qualified')
                  ? 'qualified'
                  : 'lead';
                const stage = getStage(topStage);
                const scorePct = Math.min(100, account.topScore);
                const scoreColor =
                  scorePct >= 70 ? 'bg-green-500' : scorePct >= 40 ? 'bg-amber-400' : 'bg-gray-200';

                return (
                  <tr key={account.company} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3">
                      <p className="font-medium text-gray-900">{account.company}</p>
                      {account.vertical && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {ABM_VERTICALS.find((v) => v.key === account.vertical)?.label ?? account.vertical}
                        </p>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <span className="text-gray-700 font-semibold">{account.count}</span>
                      <span className="text-gray-400 text-xs ml-1">contact{account.count !== 1 ? 's' : ''}</span>
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex flex-wrap gap-1">
                        {account.segments.length > 0 ? (
                          account.segments.map((seg) => {
                            const s = getSegment(seg);
                            return s ? (
                              <span key={seg} className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.color}`}>
                                {s.label}
                              </span>
                            ) : null;
                          })
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${stage.color}`}>
                        {stage.label}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${scoreColor}`} style={{ width: `${scorePct}%` }} />
                        </div>
                        <span className="text-xs text-gray-500">{account.topScore}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3 text-xs text-gray-400">
                      {account.lastActivity ? account.lastActivity.toLocaleDateString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Guidance callout */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 text-sm text-blue-800 space-y-1">
        <p className="font-semibold">Compliant list-building for Oracle EBS targets</p>
        <ul className="list-disc list-inside text-blue-700 space-y-0.5 text-xs mt-1">
          <li>Use Apollo.io or ZoomInfo (source: Apollo.io / ZoomInfo) for verified opt-in contacts — import via the Contacts importer</li>
          <li>Oracle Community Forum, OAUG/Quest, and Stack Overflow do not expose member emails — engage organically to drive inbound</li>
          <li>Tag each prospect with a persona segment (apps-dba, ebs-engineer, etc.) and vertical so they appear here</li>
          <li>All cold outreach must include a clear opt-out per CAN-SPAM; use the campaigns module to send and track</li>
        </ul>
      </div>
    </div>
  );
}
