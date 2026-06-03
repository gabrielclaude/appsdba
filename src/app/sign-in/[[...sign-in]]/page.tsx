import { SignIn } from '@clerk/nextjs';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign In' };

export default function SignInPage() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center py-12">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Welcome back</h1>
        <p className="text-gray-500 mt-1">Sign in to access premium runbooks and guides</p>
      </div>
      <SignIn />
    </div>
  );
}
