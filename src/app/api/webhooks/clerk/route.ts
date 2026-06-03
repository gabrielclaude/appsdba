import { Webhook } from 'svix';
import { NextRequest } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  const body = await request.text();
  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response('Missing svix headers', { status: 400 });
  }

  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET!);
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as typeof event;
  } catch {
    return new Response('Webhook signature verification failed', { status: 400 });
  }

  const { type, data } = event;

  try {
    switch (type) {
      case 'user.created':
      case 'user.updated': {
        const emailAddresses = data.email_addresses as Array<{ email_address: string }> | undefined;
        const externalAccounts = data.external_accounts as Array<{ provider: string }> | undefined;
        const email = emailAddresses?.[0]?.email_address ?? '';
        const provider = externalAccounts?.[0]?.provider ?? 'email';

        await db
          .insert(users)
          .values({
            clerkUserId: data.id as string,
            email,
            firstName: (data.first_name as string) ?? null,
            lastName: (data.last_name as string) ?? null,
            imageUrl: (data.image_url as string) ?? null,
            provider,
          })
          .onConflictDoUpdate({
            target: users.clerkUserId,
            set: {
              email,
              firstName: (data.first_name as string) ?? null,
              lastName: (data.last_name as string) ?? null,
              imageUrl: (data.image_url as string) ?? null,
              provider,
              updatedAt: new Date(),
            },
          });
        break;
      }

      case 'user.deleted': {
        await db.delete(users).where(eq(users.clerkUserId, data.id as string));
        break;
      }
    }
  } catch (err) {
    console.error('Clerk webhook handler error:', err);
    return new Response('Internal error', { status: 500 });
  }

  return new Response(null, { status: 200 });
}
