import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig) return new Response('Missing stripe-signature header', { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return new Response('Webhook signature verification failed', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const clerkUserId = session.client_reference_id;
        const stripeCustomerId = session.customer as string;
        const stripeSubscriptionId = session.subscription as string;

        if (!clerkUserId) break;

        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        const item = sub.items.data[0];
        const priceId = item?.price.id ?? null;
        const periodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;

        await db
          .insert(subscriptions)
          .values({
            clerkUserId,
            stripeCustomerId,
            stripeSubscriptionId,
            stripePriceId: priceId,
            status: 'active',
            currentPeriodEnd: periodEnd,
          })
          .onConflictDoUpdate({
            target: subscriptions.clerkUserId,
            set: {
              stripeCustomerId,
              stripeSubscriptionId,
              stripePriceId: priceId,
              status: 'active',
              currentPeriodEnd: periodEnd,
              updatedAt: new Date(),
            },
          });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const stripeCustomerId = sub.customer as string;
        const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : 'canceled';
        const item = sub.items.data[0];
        const periodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;

        await db
          .update(subscriptions)
          .set({ status, currentPeriodEnd: periodEnd, updatedAt: new Date() })
          .where(eq(subscriptions.stripeCustomerId, stripeCustomerId));
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await db
          .update(subscriptions)
          .set({ status: 'canceled', updatedAt: new Date() })
          .where(eq(subscriptions.stripeCustomerId, sub.customer as string));
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await db
          .update(subscriptions)
          .set({ status: 'past_due', updatedAt: new Date() })
          .where(eq(subscriptions.stripeCustomerId, invoice.customer as string));
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return new Response('Internal error', { status: 500 });
  }

  return new Response(null, { status: 200 });
}
