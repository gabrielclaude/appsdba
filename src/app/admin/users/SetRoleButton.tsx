'use client';
import { useState } from 'react';

export function SetRoleButton({ clerkUserId, email }: { clerkUserId: string; email: string }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSetAdmin() {
    if (!confirm(`Grant admin role to ${email}?`)) return;
    setLoading(true);
    const res = await fetch('/api/admin/users/set-role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clerkUserId, role: 'admin' }),
    });
    setLoading(false);
    if (res.ok) setDone(true);
  }

  if (done) return <span className="text-xs text-green-600">Admin set ✓</span>;
  return (
    <button
      onClick={handleSetAdmin}
      disabled={loading}
      className="text-xs text-orange-600 hover:text-orange-700 disabled:opacity-50"
    >
      {loading ? 'Setting…' : 'Set Admin'}
    </button>
  );
}
