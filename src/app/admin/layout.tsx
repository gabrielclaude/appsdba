import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';

const navItems = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/marketing', label: 'Marketing' },
  { href: '/admin/email', label: 'Email' },
  { href: '/admin/email/analytics', label: 'Email Analytics' },
  { href: '/admin/accounting', label: 'Accounting' },
  { href: '/admin/expenses', label: 'Expenses' },
  { href: '/admin/users', label: 'Users' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { userId, sessionClaims } = await auth();
  if (!userId) redirect('/sign-in');
  const role = (sessionClaims?.metadata as { role?: string } | undefined)?.role;
  if (role !== 'admin') redirect('/');

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
