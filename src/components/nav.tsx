"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth, UserButton, SignInButton } from "@clerk/nextjs";

const links = [
  { href: "/dw",                   label: "Programs" },
  { href: "/concurrent-requests",  label: "Concurrent Requests" },
];

export function Nav() {
  const { isSignedIn } = useAuth();
  const path = usePathname();
  return (
    <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6">
      <Link href="/" className="font-semibold text-gray-800 text-sm shrink-0">
        EBS Perf
      </Link>

      {isSignedIn ? (
        <>
          <nav className="flex gap-4 flex-1">
            {links.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`text-sm transition ${
                  path.startsWith(href)
                    ? "text-blue-600 font-medium"
                    : "text-gray-500 hover:text-gray-800"
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>
          <UserButton />
        </>
      ) : (
        <>
          <div className="flex-1" />
          <SignInButton mode="modal">
            <button className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 transition">
              Sign in
            </button>
          </SignInButton>
        </>
      )}
    </header>
  );
}
