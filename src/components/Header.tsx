import Link from 'next/link';
import { CATEGORIES } from '@/lib/categories';

const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

async function AuthButtons() {
  if (!clerkEnabled) return null;

  const { auth } = await import('@clerk/nextjs/server');
  const { UserButton, SignInButton } = await import('@clerk/nextjs');
  const { userId } = await auth();

  if (userId) {
    return (
      <>
        <Link href="/account" className="text-xs text-gray-300 hover:text-white transition-colors hidden sm:block">
          Account
        </Link>
        <UserButton />
      </>
    );
  }

  return (
    <SignInButton mode="modal">
      <button className="text-sm px-3 py-1.5 rounded bg-orange-500 hover:bg-orange-600 text-white transition-colors cursor-pointer">
        Sign In
      </button>
    </SignInButton>
  );
}

export async function Header() {
  return (
    <header className="bg-gray-900 text-white shadow-lg">
      <div className="max-w-6xl mx-auto px-4">
        <div className="flex items-center justify-between py-4">
          <Link href="/" className="group">
            <h1 className="text-xl font-bold tracking-tight group-hover:text-orange-400 transition-colors">
              21st Century Apps DBA
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">Oracle · EBS · WebLogic · GoldenGate · RAC</p>
          </Link>

          <div className="flex items-center gap-3 shrink-0">
            <Link
              href="/pricing"
              className="text-xs text-amber-400 hover:text-amber-300 font-medium transition-colors hidden sm:block"
            >
              Pricing
            </Link>
            <AuthButtons />
          </div>
        </div>

        <nav className="flex gap-1 pb-2 overflow-x-auto scrollbar-none">
          <Link
            href="/"
            className="text-sm px-3 py-1.5 rounded text-gray-300 hover:bg-gray-700 hover:text-white transition-colors whitespace-nowrap"
          >
            All Posts
          </Link>
          {Object.entries(CATEGORIES).map(([key, { label }]) => (
            <Link
              key={key}
              href={`/category/${key}`}
              className="text-sm px-3 py-1.5 rounded text-gray-300 hover:bg-gray-700 hover:text-white transition-colors whitespace-nowrap"
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
