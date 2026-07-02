import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { emailContacts, emailCampaigns, emailSends } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

export async function POST(req: Request) {
  const { userId, sessionClaims } = await auth();
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const role = (sessionClaims?.metadata as { role?: string })?.role;
  if (role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

  const { campaignId } = await req.json();
  if (!campaignId) return Response.json({ error: 'Missing campaignId' }, { status: 400 });

  const [campaign] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, campaignId))
    .limit(1);

  if (!campaign) return Response.json({ error: 'Campaign not found' }, { status: 404 });
  if (campaign.status !== 'draft') {
    return Response.json({ error: 'Campaign already sent or not a draft' }, { status: 400 });
  }

  const subscribedContacts = await db
    .select()
    .from(emailContacts)
    .where(eq(emailContacts.status, 'subscribed'));

  if (subscribedContacts.length === 0) {
    return Response.json({ error: 'No subscribed contacts' }, { status: 400 });
  }

  const now = new Date();
  const sends = subscribedContacts.map((contact) => ({
    campaignId,
    contactId: contact.id,
    status: 'sent' as const,
    sentAt: now,
  }));

  await db.insert(emailSends).values(sends);

  for (const contact of subscribedContacts) {
    await db
      .update(emailContacts)
      .set({ emailsSent: sql`${emailContacts.emailsSent} + 1`, updatedAt: now })
      .where(eq(emailContacts.id, contact.id));
  }

  await db
    .update(emailCampaigns)
    .set({
      status: 'sent',
      sentAt: now,
      totalSent: subscribedContacts.length,
      updatedAt: now,
    })
    .where(eq(emailCampaigns.id, campaignId));

  return Response.json({ success: true, sent: subscribedContacts.length });
}
