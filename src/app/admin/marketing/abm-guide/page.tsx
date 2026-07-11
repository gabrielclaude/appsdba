export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { db } from '@/db';
import { posts } from '@/db/schema';
import { eq } from 'drizzle-orm';

export default async function AbmGuidePage() {
  const rows = await db
    .select({ title: posts.title, slug: posts.slug, content: posts.content, publishedAt: posts.publishedAt })
    .from(posts)
    .where(eq(posts.slug, 'oracle-ebs-account-based-marketing'))
    .limit(1);

  const post = rows[0] ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">ABM Strategy Guide</h1>
          <p className="text-sm text-gray-400 mt-0.5">Account Based Marketing for Oracle EBS</p>
        </div>
        <div className="flex gap-3">
          <Link
            href="/admin/marketing/crm/abm"
            className="text-sm font-medium bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-4 py-2 rounded-lg transition-colors"
          >
            Target Accounts →
          </Link>
          <Link
            href="/admin/marketing/crm"
            className="text-sm font-medium bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 px-4 py-2 rounded-lg transition-colors"
          >
            Prospect Pipeline →
          </Link>
        </div>
      </div>

      {/* Quick-start checklist */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">90-Day Quick-Start Checklist</h2>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide">Days 1–30 · Build the list</p>
            <ul className="text-xs text-gray-600 space-y-1.5">
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Identify 50 tier-1 EBS target companies</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Use Apollo.io to find 2 contacts per company (1 technical, 1 manager)</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span><Link href="/admin/email/contacts" className="text-orange-600 hover:underline">Import contacts</Link> with source + persona tags</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Add all accounts to <Link href="/admin/marketing/crm/abm" className="text-orange-600 hover:underline">Target Accounts</Link> with vertical tag</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Score each account (60+ = tier-1 for direct outreach)</li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Days 31–60 · Warm the audience</p>
            <ul className="text-xs text-gray-600 space-y-1.5">
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Publish 5–8 technical runbooks targeting practitioner search terms</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Engage on Oracle Community Forum and OAUG/Quest threads</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>LinkedIn: connect with director-level contacts at tier-1 accounts</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Answer Stack Overflow questions with links to relevant runbooks</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Track inbound opt-ins by company — note tier-1 accounts engaging</li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">Days 61–90 · Direct outreach</p>
            <ul className="text-xs text-gray-600 space-y-1.5">
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Launch DBA/engineer sequence: 4 emails, weekly, one runbook each</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Launch manager sequence: 2 emails over 4 weeks, risk/cost framing</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Move any account with dual-persona opens to <Link href="/admin/marketing/crm" className="text-orange-600 hover:underline">Qualified stage</Link></li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Schedule 30-min calls with tier-1 managers who clicked through</li>
              <li className="flex gap-2"><span className="text-gray-300 flex-shrink-0">○</span>Review open rates by segment — adjust subject lines below 15%</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Persona reference */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-block bg-indigo-100 text-indigo-700 text-xs font-medium px-2 py-0.5 rounded-full">Apps DBA / EBS Engineer</span>
            <span className="text-xs text-gray-400">Technical persona</span>
          </div>
          <div className="space-y-3 text-xs text-gray-600">
            <div>
              <p className="font-semibold text-gray-700 mb-1">Channels</p>
              <p>Oracle Community Forum · Stack Overflow (oracle-ebs tag) · GitHub · OAUG/Quest technical SIGs</p>
            </div>
            <div>
              <p className="font-semibold text-gray-700 mb-1">Subject line style</p>
              <p className="font-mono text-gray-500 bg-gray-50 rounded p-2 leading-relaxed">
                RMAN duplicate on 12.2 — the DBID clause mistake<br />
                AutoConfig overwriting custom TNS — how to survive it<br />
                adop fs_clone took 6 hours — what to check first
              </p>
            </div>
            <div>
              <p className="font-semibold text-gray-700 mb-1">Offer</p>
              <p>Free runbook or checklist — no login required for first touch. Opt-in ask at end of content.</p>
            </div>
            <div>
              <p className="font-semibold text-gray-700 mb-1">Target open rate</p>
              <p>25–35% (specificity drives this — generic subjects fall below 15%)</p>
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-block bg-amber-100 text-amber-700 text-xs font-medium px-2 py-0.5 rounded-full">EBS Manager / IT Director</span>
            <span className="text-xs text-gray-400">Decision-maker persona</span>
          </div>
          <div className="space-y-3 text-xs text-gray-600">
            <div>
              <p className="font-semibold text-gray-700 mb-1">Channels</p>
              <p>LinkedIn · COLLABORATE management track · Peer referrals · Industry analyst reports</p>
            </div>
            <div>
              <p className="font-semibold text-gray-700 mb-1">Subject line style</p>
              <p className="font-mono text-gray-500 bg-gray-50 rounded p-2 leading-relaxed">
                EBS 12.2 support ends 2032 — what that actually costs<br />
                Three audit findings Oracle EBS shops get<br />
                When your senior DBA retires: EBS knowledge risk
              </p>
            </div>
            <div>
              <p className="font-semibold text-gray-700 mb-1">Offer</p>
              <p>Gated strategic guide or readiness assessment — email capture justified. CTA: 30-min call or team trial.</p>
            </div>
            <div>
              <p className="font-semibold text-gray-700 mb-1">Target open rate</p>
              <p>20–28% · Click-through 4–8% · Trial conversion 5–10%</p>
            </div>
          </div>
        </div>
      </div>

      {/* Account scoring */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Account Scoring Guide</h2>
        <div className="grid grid-cols-2 gap-6">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 uppercase tracking-wide">
                <th className="text-left pb-2 font-medium">Signal</th>
                <th className="text-right pb-2 font-medium">Points</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 text-gray-600">
              {[
                ['EBS 12.2 confirmed', 20],
                ['1,000+ employees', 15],
                ['Active OAUG/Quest presence', 15],
                ['On-premise (not on Fusion)', 10],
                ['Manufacturing or healthcare vertical', 10],
                ['Multiple EBS modules (SCM + Fin + HR)', 10],
                ['IT director identified by name', 10],
                ['Conference presenter / speaker', 10],
              ].map(([signal, pts]) => (
                <tr key={String(signal)}>
                  <td className="py-1.5">{signal}</td>
                  <td className="py-1.5 text-right font-medium text-gray-800">+{pts}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-3">
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3">
              <p className="text-xs font-semibold text-green-800">60+ points — Tier 1</p>
              <p className="text-xs text-green-700 mt-0.5">Direct outreach: personalized email sequence + LinkedIn engagement. Priority for 30-min call.</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <p className="text-xs font-semibold text-amber-800">40–59 points — Tier 2</p>
              <p className="text-xs text-amber-700 mt-0.5">Content marketing + community engagement. Add to email list via opt-in. Watch for inbound signals.</p>
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
              <p className="text-xs font-semibold text-gray-700">Under 40 — Tier 3</p>
              <p className="text-xs text-gray-500 mt-0.5">Organic search traffic only. Do not invest direct outreach budget.</p>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
              <p className="text-xs font-semibold text-blue-800">Set the score field in the CRM</p>
              <p className="text-xs text-blue-700 mt-0.5">The pipeline score bar reflects this — green ≥70, amber ≥40, gray below 40.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Compliance reminder */}
      <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 text-xs text-red-800 space-y-1">
        <p className="font-semibold text-sm">CAN-SPAM compliance — required before any outreach</p>
        <ul className="list-disc list-inside text-red-700 space-y-0.5 mt-1">
          <li>All cold emails must include a physical postal address and a functional one-click opt-out</li>
          <li>Opt-out requests must be honored within 10 business days</li>
          <li>Email addresses obtained from Apollo.io / ZoomInfo satisfy the no-harvesting requirement — Oracle Community Forum or LinkedIn scrapes do not</li>
          <li>For EU contacts: review legitimate interest basis and document before sending to any EU company</li>
        </ul>
      </div>

      {/* Full blog post */}
      {post && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Full Strategy Post</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Published {post.publishedAt ? new Date(post.publishedAt).toLocaleDateString() : '—'} ·{' '}
                <Link href={`/blog/${post.slug}`} className="text-orange-600 hover:underline" target="_blank">
                  View public post →
                </Link>
              </p>
            </div>
          </div>
          <div className="px-6 py-6 prose prose-sm prose-gray max-w-none">
            {post.content.split('\n').map((line, i) => {
              if (line.startsWith('## ')) return <h2 key={i} className="text-base font-bold text-gray-900 mt-6 mb-2">{line.slice(3)}</h2>;
              if (line.startsWith('### ')) return <h3 key={i} className="text-sm font-semibold text-gray-800 mt-4 mb-1">{line.slice(4)}</h3>;
              if (line === '---') return <hr key={i} className="border-gray-100 my-4" />;
              if (line.trim() === '') return <div key={i} className="h-2" />;
              if (line.startsWith('**') && line.endsWith('**')) return <p key={i} className="font-semibold text-gray-800 text-xs">{line.slice(2, -2)}</p>;
              return <p key={i} className="text-xs text-gray-600 leading-relaxed">{line}</p>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}
