import type { Metadata } from 'next';
import { CheckoutButton } from '@/components/CheckoutButton';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Unlock every Oracle DBA runbook for one low price.',
};

const MONTHLY_PRICE_ID = process.env.STRIPE_MONTHLY_PRICE_ID!;
const YEARLY_PRICE_ID = process.env.STRIPE_YEARLY_PRICE_ID!;

const INCLUDED = [
  'All step-by-step runbooks — Oracle, EBS, SOA Suite, FMW, Exadata',
  'Installation, patching, HA, backup/recovery guides',
  'Performance tuning and security hardening runbooks',
  'New runbooks added regularly',
  'Cancel anytime',
];

export default function PricingPage() {
  return (
    <div className="max-w-3xl mx-auto py-8">
      <div className="text-center mb-12">
        <h1 className="text-3xl font-bold text-gray-900 mb-3">Runbook Access</h1>
        <p className="text-lg text-gray-600">
          One subscription unlocks every premium runbook on the site — past and future.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-6 mb-12">
        {/* Monthly */}
        <div className="border border-gray-200 rounded-xl p-8 bg-white shadow-sm flex flex-col">
          <div className="mb-6">
            <p className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-1">Monthly</p>
            <div className="flex items-end gap-1">
              <span className="text-4xl font-bold text-gray-900">$9</span>
              <span className="text-gray-500 mb-1">/ month</span>
            </div>
          </div>
          <ul className="space-y-2 text-sm text-gray-600 flex-1 mb-8">
            {INCLUDED.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="text-green-500 shrink-0">✓</span>
                {item}
              </li>
            ))}
          </ul>
          <CheckoutButton
            priceId={MONTHLY_PRICE_ID}
            label="Subscribe Monthly"
            className="w-full bg-orange-500 hover:bg-orange-600 text-white"
          />
        </div>

        {/* Yearly */}
        <div className="border-2 border-orange-400 rounded-xl p-8 bg-white shadow-sm flex flex-col relative">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-orange-500 text-white text-xs font-bold px-3 py-1 rounded-full">
              BEST VALUE
            </span>
          </div>
          <div className="mb-6">
            <p className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-1">Yearly</p>
            <div className="flex items-end gap-1">
              <span className="text-4xl font-bold text-gray-900">$79</span>
              <span className="text-gray-500 mb-1">/ year</span>
            </div>
            <p className="text-sm text-green-600 font-medium mt-1">Save 27% vs monthly</p>
          </div>
          <ul className="space-y-2 text-sm text-gray-600 flex-1 mb-8">
            {INCLUDED.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="text-green-500 shrink-0">✓</span>
                {item}
              </li>
            ))}
          </ul>
          <CheckoutButton
            priceId={YEARLY_PRICE_ID}
            label="Subscribe Yearly"
            className="w-full bg-gray-900 hover:bg-gray-800 text-white"
          />
        </div>
      </div>

      <p className="text-center text-sm text-gray-400">
        Payments processed securely by Stripe. Cancel anytime from your account page.
      </p>
    </div>
  );
}
