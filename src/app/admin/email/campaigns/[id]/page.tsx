export const dynamic = 'force-dynamic';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { emailContacts, emailCampaigns, emailSends, emailEvents } from '@/db/schema';
import { getCampaignById, getCampaignSends, getAllContacts } from '@/lib/email-marketing';
import { auth } from '@clerk/nextjs/server';
import { eq, count, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { CampaignContactSelector } from './CampaignContactSelector';

async function sendCampaign(campaignId: number, formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const contactIds = (formData.getAll('contactId') as string[])
    .map((id) => parseInt(id))
    .filter((id) => !isNaN(id));

  if (contactIds.length === 0) return;

  const [campaign] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, campaignId))
    .limit(1);

  if (!campaign || campaign.status !== 'draft') return;

  const selectedContacts = await db
    .select()
    .from(emailContacts)
    .where(inArray(emailContacts.id, contactIds));

  if (selectedContacts.length === 0) return;

  const now = new Date();

  await db.insert(emailSends).values(
    selectedContacts.map((c) => ({
      campaignId,
      contactId: c.id,
      status: 'sent' as const,
      sentAt: now,
    })),
  );

  for (const contact of selectedContacts) {
    await db
      .update(emailContacts)
      .set({ emailsSent: sql`${emailContacts.emailsSent} + 1`, updatedAt: now })
      .where(eq(emailContacts.id, contact.id));
  }

  await db
    .update(emailCampaigns)
    .set({ status: 'sent', sentAt: now, totalSent: selectedContacts.length, updatedAt: now })
    .where(eq(emailCampaigns.id, campaignId));

  // Deliver via Resend if configured
  if (process.env.RESEND_API_KEY) {
    const { sendEmail } = await import('@/lib/email-send');
    for (const contact of selectedContacts) {
      try {
        await sendEmail({ to: contact.email, subject: campaign.subject, html: campaign.bodyHtml });
      } catch (err) {
        console.error(`Email delivery failed for ${contact.email}:`, err);
      }
    }
  }

  revalidatePath(`/admin/email/campaigns/${campaignId}`);
  revalidatePath('/admin/email/campaigns');
  revalidatePath('/admin/email');
  redirect(`/admin/email/campaigns/${campaignId}`);
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-600',
    scheduled: 'bg-blue-100 text-blue-700',
    sending: 'bg-yellow-100 text-yellow-700',
    sent: 'bg-green-100 text-green-700',
    canceled: 'bg-red-100 text-red-600',
    pending: 'bg-gray-100 text-gray-500',
    failed: 'bg-red-100 text-red-600',
    bounced: 'bg-yellow-100 text-yellow-700',
  };
  return colors[status] ?? 'bg-gray-100 text-gray-600';
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const campaignId = parseInt(id);

  const [campaign, sends, contacts] = await Promise.all([
    getCampaignById(campaignId),
    getCampaignSends(campaignId, 200),
    getAllContacts(500),
  ]);

  if (!campaign) {
    return (
      <div className="text-white">
        <p>Campaign not found.</p>
        <Link href="/admin/email/campaigns" className="text-orange-400">
          Back to Campaigns
        </Link>
      </div>
    );
  }

  // Aggregate events per send
  const sendIds = sends.map((s) => s.send.id);
  const eventCounts: Record<number, { opens: number; clicks: number }> = {};
  for (const sid of sendIds) eventCounts[sid] = { opens: 0, clicks: 0 };

  if (sendIds.length > 0) {
    const events = await db
      .select({
        sendId: emailEvents.sendId,
        eventType: emailEvents.eventType,
        cnt: count(),
      })
      .from(emailEvents)
      .where(eq(emailEvents.campaignId, campaignId))
      .groupBy(emailEvents.sendId, emailEvents.eventType);

    for (const ev of events) {
      if (!eventCounts[ev.sendId]) eventCounts[ev.sendId] = { opens: 0, clicks: 0 };
      if (ev.eventType === 'open') eventCounts[ev.sendId].opens = Number(ev.cnt);
      if (ev.eventType === 'click') eventCounts[ev.sendId].clicks = Number(ev.cnt);
    }
  }

  const openRate = campaign.totalSent > 0 ? (campaign.totalOpens / campaign.totalSent) * 100 : 0;
  const clickRate = campaign.totalSent > 0 ? (campaign.totalClicks / campaign.totalSent) * 100 : 0;

  const sendCampaignBound = sendCampaign.bind(null, campaignId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link href="/admin/email/campaigns" className="text-sm text-gray-400 hover:text-gray-600">
              ← Campaigns
            </Link>
            <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusBadge(campaign.status)}`}>
              {campaign.status}
            </span>
          </div>
          <h1 className="text-2xl font-bold text-white">{campaign.name}</h1>
          <p className="text-gray-400 text-sm mt-1">{campaign.subject}</p>
          {campaign.category && (
            <p className="text-gray-400 text-xs mt-0.5">Category: {campaign.category}</p>
          )}
          {campaign.postTitle && (
            <p className="text-gray-400 text-xs mt-0.5">Post: {campaign.postTitle}</p>
          )}
        </div>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Total Sent</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{campaign.totalSent.toLocaleString()}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Opens</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{campaign.totalOpens.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{openRate.toFixed(1)}% open rate</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Clicks</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{campaign.totalClicks.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{clickRate.toFixed(1)}% click rate</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Unsubscribes</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{campaign.totalUnsubscribes.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{campaign.totalBounces} bounces</p>
        </div>
      </div>

      {/* Send section (draft only) */}
      {campaign.status === 'draft' && (
        <div className="bg-white border border-orange-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Send Campaign</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Select recipients, then send — or send a test email first.
                {!process.env.RESEND_API_KEY && (
                  <span className="text-yellow-600 ml-2">
                    (RESEND_API_KEY not set — records will be marked sent without delivery)
                  </span>
                )}
              </p>
            </div>
          </div>
          <CampaignContactSelector
            contacts={contacts}
            campaignId={campaignId}
            sendAction={sendCampaignBound}
          />
        </div>
      )}

      {/* Recipient list */}
      {sends.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Recipients <span className="text-gray-400 font-normal text-sm">({sends.length})</span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 text-gray-500">Name</th>
                  <th className="text-left py-2 text-gray-500">Email</th>
                  <th className="text-left py-2 text-gray-500">Status</th>
                  <th className="text-left py-2 text-gray-500">Sent At</th>
                  <th className="text-right py-2 text-gray-500">Opens</th>
                  <th className="text-right py-2 text-gray-500">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {sends.map(({ send, contact }) => (
                  <tr key={send.id} className="border-b border-gray-50">
                    <td className="py-2 font-medium text-gray-800">
                      {contact.firstName} {contact.lastName}
                    </td>
                    <td className="py-2 text-gray-600">{contact.email}</td>
                    <td className="py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusBadge(send.status)}`}>
                        {send.status}
                      </span>
                    </td>
                    <td className="py-2 text-gray-400 text-xs">
                      {send.sentAt ? new Date(send.sentAt).toLocaleString() : '—'}
                    </td>
                    <td className="py-2 text-right text-gray-700">{eventCounts[send.id]?.opens ?? 0}</td>
                    <td className="py-2 text-right text-gray-700">{eventCounts[send.id]?.clicks ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
