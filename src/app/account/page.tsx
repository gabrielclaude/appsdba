import { redirect } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { getSubscription, isActive } from '@/lib/subscriptions';
import { ManageSubscriptionButton } from '@/components/ManageSubscriptionButton';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage() {
  const { auth, currentUser } = await import('@clerk/nextjs/server');
  const { UserButton } = await import('@clerk/nextjs');
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const [user, sub] = await Promise.all([currentUser(), getSubscription(userId)]);
  const subscribed = isActive(sub);

  const displayName =
    user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}`
      : user?.firstName ?? user?.emailAddresses?.[0]?.emailAddress ?? 'Your Account';

  const email = user?.emailAddresses?.[0]?.emailAddress;
  const isGoogleAccount = user?.externalAccounts?.some((a) => a.provider === 'oauth_google');

  return (
    <div className="max-w-xl mx-auto py-8 space-y-6">
      {/* Profile */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center gap-4">
          {user?.imageUrl ? (
            <Image
              src={user.imageUrl}
              alt={displayName}
              width={56}
              height={56}
              className="rounded-full"
            />
          ) : (
            <div className="w-14 h-14 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold text-xl">
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-gray-900 truncate">{displayName}</h1>
            {email && <p className="text-sm text-gray-500 truncate">{email}</p>}
            {isGoogleAccount && (
              <span className="inline-flex items-center gap-1 text-xs text-gray-400 mt-0.5">
                <svg viewBox="0 0 24 24" className="w-3 h-3" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Signed in with Google
              </span>
            )}
          </div>
          <UserButton />
        </div>
      </div>

      {/* Subscription */}
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
