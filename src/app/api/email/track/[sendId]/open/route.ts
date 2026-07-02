import { db } from '@/db';
import { emailSends, emailEvents, emailCampaigns } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sendId: string }> },
) {
  const { sendId } = await params;
  const id = parseInt(sendId);

  if (!isNaN(id)) {
    const [send] = await db.select().from(emailSends).where(eq(emailSends.id, id)).limit(1);
    if (send) {
      await db.insert(emailEvents).values({
        sendId: id,
        campaignId: send.campaignId,
        contactId: send.contactId,
        eventType: 'open',
      });
      await db
        .update(emailCampaigns)
        .set({ totalOpens: sql`${emailCampaigns.totalOpens} + 1` })
        .where(eq(emailCampaigns.id, send.campaignId));
    }
  }

  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  return new Response(pixel, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    },
  });
}
