import { auth } from '@clerk/nextjs/server';
import { stripe } from '@/lib/stripe';
import { getSubscription } from '@/lib/subscriptions';

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const { priceId } = await request.json();
  if (!priceId) return new Response('Missing priceId', { status: 400 });

  const existing = await getSubscription(userId);

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'subscription',
    client_reference_id: userId,
    customer: existing?.stripeCustomerId ?? undefined,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.NEXT_PUBLIC_URL}/?checkout=success`,
    cancel_url: `${process.env.NEXT_PUBLIC_URL}/pricing`,
    subscription_data: {
      metadata: { clerkUserId: userId },
    },
  });

  return Response.json({ url: session.url });
}
