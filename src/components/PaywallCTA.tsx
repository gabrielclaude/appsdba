import Link from 'next/link';
import { CheckoutButton } from './CheckoutButton';

interface PaywallCTAProps {
  userId: string | null;
  monthlyPriceId: string;
  yearlyPriceId: string;
}

export function PaywallCTA({ userId, monthlyPriceId, yearlyPriceId }: PaywallCTAProps) {
  return (
    <div className="mt-0 relative">
      {/* Fade gradient over the end of the preview */}
      <div className="absolute -top-24 left-0 right-0 h-24 bg-gradient-to-b from-transparent to-white pointer-events-none" />

      <div className="border border-amber-200 bg-amber-50 rounded-xl p-8 text-center shadow-sm">
        <div className="text-3xl mb-3">🔒</div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">Premium Runbook</h3>
        <p className="text-gray-600 mb-6 max-w-md mx-auto">
          This step-by-step runbook is available to subscribers. Unlock every runbook on the site for one low price.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-6">
          {userId ? (
            <>
              <CheckoutButton
                priceId={monthlyPriceId}
                label="Subscribe — $9 / month"
                className="bg-orange-500 hover:bg-orange-600 text-white px-6"
              />
              <CheckoutButton
                priceId={yearlyPriceId}
                label="Subscribe — $79 / year (save 27%)"
                className="bg-gray-800 hover:bg-gray-900 text-white px-6"
              />
            </>
          ) : (
            <Link
              href="/sign-in"
              className="inline-flex items-center justify-center rounded-md bg-orange-500 hover:bg-orange-600 text-white px-6 py-2 text-sm font-medium transition-colors"
            >
              Sign in to subscribe
            </Link>
          )}
        </div>

        <ul className="text-sm text-gray-500 space-y-1 max-w-xs mx-auto text-left">
          <li>✓ All runbooks unlocked immediately</li>
          <li>✓ Step-by-step operational guides</li>
          <li>✓ Oracle, EBS, SOA, FMW, Exadata</li>
          <li>✓ Cancel anytime</li>
        </ul>

        <p className="text-xs text-gray-400 mt-4">
          Already subscribed?{' '}
          {userId ? (
            <Link href="/account" className="underline hover:text-gray-600">
              Check your account
            </Link>
          ) : (
            <Link href="/sign-in" className="underline hover:text-gray-600">
              Sign in
            </Link>
          )}
        </p>
      </div>
    </div>
  );
}
