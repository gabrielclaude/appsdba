'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function ManageSubscriptionButton() {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch('/api/stripe/create-portal', { method: 'POST' });
      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  }

  return (
    <Button variant="outline" onClick={handleClick} disabled={loading}>
      {loading ? 'Loading...' : 'Manage Subscription'}
    </Button>
  );
}
