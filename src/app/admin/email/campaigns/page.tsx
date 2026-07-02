export const dynamic = 'force-dynamic';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { db } from '@/db';
import { emailCampaigns } from '@/db/schema';
import { getAllCampaigns } from '@/lib/email-marketing';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';

async function deleteCampaign(id: number) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');
  const [campaign] = await db
    .select({ status: emailCampaigns.status })
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!campaign || campaign.status !== 'draft') return;
  await db.delete(emailCampaigns).where(eq(emailCampaigns.id, id));
  revalidatePath('/admin/email/campaigns');
  revalidatePath('/admin/email');
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-600',
    scheduled: 'bg-blue-100 text-blue-700',
    sending: 'bg-yellow-100 text-yellow-700',
    sent: 'bg-green-100 text-green-700',
    canceled: 'bg-red-100 text-red-600',
  };
  return colors[status] ?? 'bg-gray-100 text-gray-600';
}

export default async function CampaignsPage() {
  const campaigns = await getAllCampaigns(100);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Campaigns</h1>
        <Link
          href="/admin/email/campaigns/new"
          className="text-sm bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg transition-colors"
        >
          + Create Campaign
        </Link>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          All Campaigns <span className="text-gray-400 font-normal text-sm">({campaigns.length})</span>
        </h2>
        {campaigns.length === 0 ? (
          <p className="text-sm text-gray-400">
            No campaigns yet.{' '}
            <Link href="/admin/email/campaigns/new" className="text-orange-600">
              Create one.
            </Link>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 text-gray-500">Name</th>
                  <th className="text-left py-2 text-gray-500">Subject</th>
                  <th className="text-left py-2 text-gray-500">Status</th>
                  <th className="text-left py-2 text-gray-500">Category</th>
                  <th className="text-right py-2 text-gray-500">Sent</th>
                  <th className="text-right py-2 text-gray-500">Open Rate</th>
                  <th className="text-right py-2 text-gray-500">Click Rate</th>
                  <th className="text-left py-2 text-gray-500">Created</th>
                  <th className="text-left py-2 text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => {
                  const openRate = c.totalSent > 0 ? (c.totalOpens / c.totalSent) * 100 : 0;
                  const clickRate = c.totalSent > 0 ? (c.totalClicks / c.totalSent) * 100 : 0;
                  return (
                    <tr key={c.id} className="border-b border-gray-50">
                      <td className="py-2 font-medium text-gray-800">{c.name}</td>
                      <td className="py-2 text-gray-600 max-w-xs">
                        <span className="truncate block" title={c.subject}>
                          {c.subject.length > 40 ? c.subject.slice(0, 40) + '…' : c.subject}
                        </span>
                      </td>
                      <td className="py-2">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusBadge(c.status)}`}>
                          {c.status}
                        </span>
                      </td>
                      <td className="py-2 text-gray-500 text-xs">{c.category ?? '—'}</td>
                      <td className="py-2 text-right text-gray-700">{c.totalSent.toLocaleString()}</td>
                      <td className="py-2 text-right text-gray-700">{openRate.toFixed(1)}%</td>
                      <td className="py-2 text-right text-gray-700">{clickRate.toFixed(1)}%</td>
                      <td className="py-2 text-gray-400 text-xs">
                        {new Date(c.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-3">
                          <Link
                            href={`/admin/email/campaigns/${c.id}`}
                            className="text-xs text-orange-600 hover:text-orange-700"
                          >
                            View
                          </Link>
                          {c.status === 'draft' && (
                            <form action={deleteCampaign.bind(null, c.id)}>
                              <button
                                type="submit"
                                className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                              >
                                Delete
                              </button>
                            </form>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
