import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { emailCampaigns } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { sendEmail } from '@/lib/email-send';

const TEST_RECIPIENT = 'gabriel.claude@gmail.com';

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

  try {
    await sendEmail({
      to: TEST_RECIPIENT,
      subject: `[TEST] ${campaign.subject}`,
      html: campaign.bodyHtml,
    });
    return Response.json({ success: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Send failed' },
      { status: 500 }
    );
  }
}
