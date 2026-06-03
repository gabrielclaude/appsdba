import { SignUp } from '@clerk/nextjs';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Create Account' };

export default function SignUpPage() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center py-12">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Create your account</h1>
        <p className="text-gray-500 mt-1">Get access to Oracle DBA runbooks, patching guides, and performance tuning content</p>
      </div>
      <SignUp />
    </div>
  );
}
