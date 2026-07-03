'use client';
import { useEffect } from 'react';

export default function ContactsError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error('[contacts page error]', error);
  }, [error]);

  return (
    <div className="bg-white border border-red-200 rounded-xl p-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-red-700 mb-2">Contacts page error</h2>
      <p className="text-sm text-gray-700 mb-2 font-mono break-all">{error.message}</p>
      {error.digest && (
        <p className="text-xs text-gray-400 mb-4">Digest: {error.digest}</p>
      )}
      <button
        onClick={unstable_retry}
        className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm rounded-lg"
      >
        Try again
      </button>
    </div>
  );
}
