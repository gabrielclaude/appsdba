import Link from 'next/link';
import { CATEGORIES } from '@/lib/categories';

export function Header() {
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
