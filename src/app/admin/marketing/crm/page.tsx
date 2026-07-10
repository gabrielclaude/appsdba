import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { db } from '@/db';
import { crmProspects } from '@/db/schema';
import { getAllProspects, getPipelineCounts, getFollowUpsDue, STAGES, SOURCES, ABM_SEGMENTS, getStage } from '@/lib/crm';

export const dynamic = 'force-dynamic';

async function addProspect(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const email = (formData.get('email') as string).trim().toLowerCase();
  if (!email) return;

  const followUpRaw = formData.get('nextFollowUpAt') as string;

  await db.insert(crmProspects).values({
    firstName:      (formData.get('firstName') as string).trim() || null,
    lastName:       (formData.get('lastName') as string).trim() || null,
    email,
    company:        (formData.get('company') as string).trim() || null,
    jobTitle:       (formData.get('jobTitle') as string).trim() || null,
    phone:          (formData.get('phone') as string).trim() || null,
    source:         (formData.get('source') as string) || 'organic',
    stage:          (formData.get('stage') as string) || 'lead',
    score:          parseInt(formData.get('score') as string) || 0,
    notes:          (formData.get('notes') as string).trim() || null,
    nextFollowUpAt: followUpRaw ? new Date(followUpRaw) : null,
  });

  revalidatePath('/admin/marketing/crm');
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const color = pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-amber-400' : 'bg-gray-300';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500">{score}</span>
    </div>
  );
}

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; segment?: string }>;
}) {
  const { stage: stageFilter, segment: segmentFilter } = await searchParams;

  const [prospects, counts, followUpsDue] = await Promise.all([
    getAllProspects(stageFilter, segmentFilter),
    getPipelineCounts(),
    getFollowUpsDue(),
  ]);

  const totalActive = STAGES.filter((s) => s.key !== 'lost' && s.key !== 'converted')
    .reduce((n, s) => n + (counts[s.key] ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Prospect Pipeline</h1>
          <p className="text-sm text-gray-500 mt-0.5">{totalActive} active prospects in pipeline</p>
        </div>
        <Link
          href="/admin/marketing/crm/abm"
          className="text-sm font-medium bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-4 py-2 rounded-lg transition-colors"
        >
          Target Accounts (ABM) →
        </Link>
      </div>

      {/* ABM persona segment filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-400">Persona:</span>
        <Link
          href={stageFilter ? `/admin/marketing/crm?stage=${stageFilter}` : '/admin/marketing/crm'}
          className={`text-xs px-3 py-1 rounded-full border transition-colors ${
            !segmentFilter ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
          }`}
        >
          All
        </Link>
        {ABM_SEGMENTS.map((s) => {
          const params = new URLSearchParams();
          params.set('segment', s.key);
          if (stageFilter) params.set('stage', stageFilter);
          return (
            <Link
              key={s.key}
              href={`/admin/marketing/crm?${params.toString()}`}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                segmentFilter === s.key
                  ? `${s.color} border-current`
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
              }`}
            >
              {s.label}
            </Link>
          );
        })}
      </div>

      {/* Pipeline stage cards */}
      <div className="grid grid-cols-6 gap-3">
        {STAGES.map((s) => {
          const n = counts[s.key] ?? 0;
          const isActive = stageFilter === s.key;
          const stageParams = new URLSearchParams();
          if (!isActive) stageParams.set('stage', s.key);
          if (segmentFilter) stageParams.set('segment', segmentFilter);
          const stageHref = `/admin/marketing/crm${stageParams.toString() ? `?${stageParams.toString()}` : ''}`;
          return (
            <Link
              key={s.key}
              href={stageHref}
              className={`bg-white border rounded-xl p-4 text-center transition-all hover:shadow-sm ${
                isActive ? 'border-orange-400 ring-1 ring-orange-300' : 'border-gray-200'
              }`}
            >
              <p className="text-2xl font-bold text-gray-900">{n}</p>
              <span className={`inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full ${s.color}`}>
                {s.label}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Follow-ups due */}
      {followUpsDue.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-amber-800 mb-2">
            {followUpsDue.length} prospect{followUpsDue.length > 1 ? 's' : ''} need{followUpsDue.length === 1 ? 's' : ''} follow-up
          </p>
          <div className="space-y-1">
            {followUpsDue.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm">
                <Link href={`/admin/marketing/crm/${p.id}`} className="font-medium text-amber-900 hover:underline">
                  {p.firstName} {p.lastName} {p.company ? `· ${p.company}` : ''}
                </Link>
                <span className="text-amber-600 text-xs">
                  {p.nextFollowUpAt ? p.nextFollowUpAt.toLocaleDateString() : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add prospect form */}
      <details className="bg-white border border-gray-200 rounded-xl">
        <summary className="px-6 py-4 cursor-pointer text-sm font-semibold text-gray-700 hover:text-orange-600 select-none">
          + Add Prospect
        </summary>
        <form action={addProspect} className="px-6 pb-6 pt-2 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">First Name</label>
              <input name="firstName" type="text" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Last Name</label>
              <input name="lastName" type="text" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email <span className="text-red-500">*</span></label>
              <input name="email" type="email" required className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Company</label>
              <input name="company" type="text" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Job Title</label>
              <input name="jobTitle" type="text" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
              <input name="phone" type="tel" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Source</label>
              <select name="source" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
                {SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Stage</label>
              <select name="stage" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
                {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Score (0–100)</label>
              <input name="score" type="number" min="0" max="100" defaultValue="0" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Next Follow-up</label>
              <input name="nextFollowUpAt" type="date" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
            <textarea name="notes" rows={2} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-none" />
          </div>
          <button type="submit" className="bg-orange-500 hover:bg-orange-600 text-white px-5 py-2 rounded-lg text-sm font-medium">
            Add Prospect
          </button>
        </form>
      </details>

      {/* Prospects table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-700">
            {stageFilter ? `${getStage(stageFilter).label} ` : ''}{segmentFilter ? `[${ABM_SEGMENTS.find(s => s.key === segmentFilter)?.label ?? segmentFilter}] ` : ''}{!stageFilter && !segmentFilter ? 'All prospects' : 'prospects'}
            <span className="ml-2 text-gray-400 font-normal">({prospects.length})</span>
          </p>
          {(stageFilter || segmentFilter) && (
            <Link
              href={segmentFilter && !stageFilter ? `/admin/marketing/crm?segment=${segmentFilter}` : stageFilter && !segmentFilter ? `/admin/marketing/crm?stage=${stageFilter}` : '/admin/marketing/crm'}
              className="text-xs text-orange-600 hover:underline"
            >
              {stageFilter && segmentFilter ? 'Clear stage filter' : 'Clear filter'}
            </Link>
          )}
        </div>

        {prospects.length === 0 ? (
          <p className="px-6 py-8 text-sm text-gray-400 text-center">
            No prospects yet — add one above.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs text-gray-400 uppercase tracking-wide">
                <th className="px-6 py-3 text-left font-medium">Name / Company</th>
                <th className="px-6 py-3 text-left font-medium">Email</th>
                <th className="px-6 py-3 text-left font-medium">Stage</th>
                <th className="px-6 py-3 text-left font-medium">Score</th>
                <th className="px-6 py-3 text-left font-medium">Follow-up</th>
                <th className="px-6 py-3 text-left font-medium">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {prospects.map((p) => {
                const stage = getStage(p.stage);
                const overdue =
                  p.nextFollowUpAt &&
                  p.nextFollowUpAt <= new Date() &&
                  p.stage !== 'converted' &&
                  p.stage !== 'lost';
                return (
                  <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3">
                      <Link href={`/admin/marketing/crm/${p.id}`} className="font-medium text-gray-900 hover:text-orange-600">
                        {p.firstName || p.lastName
                          ? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()
                          : <span className="text-gray-400 italic">No name</span>}
                      </Link>
                      {p.company && <p className="text-xs text-gray-400">{p.company}</p>}
                    </td>
                    <td className="px-6 py-3 text-gray-500">{p.email}</td>
                    <td className="px-6 py-3">
                      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${stage.color}`}>
                        {stage.label}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <ScoreBar score={p.score} />
                    </td>
                    <td className="px-6 py-3">
                      {p.nextFollowUpAt ? (
                        <span className={`text-xs ${overdue ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                          {overdue ? '⚠ ' : ''}{p.nextFollowUpAt.toLocaleDateString()}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-xs text-gray-400">
                      {p.createdAt.toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
