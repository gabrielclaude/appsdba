import { db } from '@/db';
import { emailSends, emailEvents, emailCampaigns } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sendId: string }> },
) {
  const { sendId } = await params;
  const id = parseInt(sendId);
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get('url') ?? '/';

  if (!isNaN(id)) {
    const [send] = await db.select().from(emailSends).where(eq(emailSends.id, id)).limit(1);
    if (send) {
      await db.insert(emailEvents).values({
        sendId: id,
        campaignId: send.campaignId,
        contactId: send.contactId,
        eventType: 'click',
        metadata: JSON.stringify({ url: targetUrl }),
      });
      await db
        .update(emailCampaigns)
        .set({ totalClicks: sql`${emailCampaigns.totalClicks} + 1` })
        .where(eq(emailCampaigns.id, send.campaignId));
    }
  }

  const destination = targetUrl.startsWith('http')
    ? targetUrl
    : `https://appsdba.info${targetUrl}`;
  return Response.redirect(destination);
}
