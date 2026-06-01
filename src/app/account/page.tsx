import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSubscription, isActive } from '@/lib/subscriptions';
import { ManageSubscriptionButton } from '@/components/ManageSubscriptionButton';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage() {
  const { auth } = await import('@clerk/nextjs/server');
  const { UserButton } = await import('@clerk/nextjs');
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const sub = await getSubscription(userId);
  const subscribed = isActive(sub);

  return (
    <div className="max-w-xl mx-auto py-8">
      <div className="flex items-center gap-4 mb-8">
        <UserButton />
        <h1 className="text-2xl font-bold text-gray-900">Your Account</h1>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Subscription</h2>

        {subscribed ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
              <span className="text-green-700 font-medium">Active</span>
            </div>
            {sub?.currentPeriodEnd && (
              <p className="text-sm text-gray-500">
                Renews{' '}
                {new Date(sub.currentPeriodEnd).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            )}
            <ManageSubscriptionButton />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-gray-600">You don&apos;t have an active subscription.</p>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 text-sm font-medium transition-colors"
            >
              View Pricing
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
