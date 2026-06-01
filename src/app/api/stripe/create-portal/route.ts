import { auth } from '@clerk/nextjs/server';
import { stripe } from '@/lib/stripe';
import { getSubscription } from '@/lib/subscriptions';

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const sub = await getSubscription(userId);
  if (!sub?.stripeCustomerId) return new Response('No subscription found', { status: 404 });

  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${process.env.NEXT_PUBLIC_URL}/account`,
  });

  return Response.json({ url: session.url });
}
