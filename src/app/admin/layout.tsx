import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, currentUser } from '@clerk/nextjs/server';

const navItems = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/marketing', label: 'Marketing' },
  { href: '/admin/marketing/crm', label: 'Prospects' },
  { href: '/admin/marketing/crm/abm', label: 'Target Accounts' },
  { href: '/admin/marketing/abm-guide', label: 'ABM Guide' },
  { href: '/admin/email', label: 'Email' },
  { href: '/admin/email/analytics', label: 'Email Analytics' },
  { href: '/admin/accounting', label: 'Accounting' },
  { href: '/admin/expenses', label: 'Expenses' },
  { href: '/admin/users', label: 'Users' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  // currentUser() always returns latest publicMetadata, even if session token is stale
  const user = await currentUser();
  const role = user?.publicMetadata?.role as string | undefined;

  if (role !== 'admin') {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <div className="bg-white border border-gray-200 rounded-xl p-8 max-w-md">
          <p className="text-4xl mb-4">🔒</p>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Admin access required</h1>
          <p className="text-sm text-gray-500 mb-4">
            Your account has been granted admin access but your current session needs to refresh.
          </p>
          <p className="text-sm text-gray-500 mb-6">
            Please sign out and sign back in to activate your admin role.
          </p>
          <Link
            href="/sign-in"
            className="inline-block bg-orange-500 hover:bg-orange-600 text-white px-6 py-2 rounded-lg text-sm font-medium"
          >
            Sign out &amp; sign back in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-6 min-h-[calc(100vh-200px)]">
      {/* Sidebar */}
      <aside className="w-48 flex-shrink-0">
        <div className="bg-white border border-gray-200 rounded-xl p-4 sticky top-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Admin</p>
          <nav className="space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-orange-50 hover:text-orange-600 transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </aside>
      {/* Main content */}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
