'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface CheckoutButtonProps {
  priceId: string;
  label: string;
  className?: string;
}

export function CheckoutButton({ priceId, label, className }: CheckoutButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch('/api/stripe/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId }),
      });

      if (res.status === 401) {
        window.location.href = '/sign-in?redirect_url=' + encodeURIComponent(window.location.href);
        return;
      }

      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleClick} disabled={loading} className={className}>
      {loading ? 'Loading...' : label}
    </Button>
  );
}
