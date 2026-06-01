import { db } from '@/db';
import { subscriptions, type Subscription } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getSubscription(clerkUserId: string): Promise<Subscription | null> {
  const result = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.clerkUserId, clerkUserId))
    .limit(1);
  return result[0] ?? null;
}

export function isActive(sub: Subscription | null): boolean {
  if (!sub || sub.status !== 'active') return false;
  if (sub.currentPeriodEnd && sub.currentPeriodEnd < new Date()) return false;
  return true;
}
