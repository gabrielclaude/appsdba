'use client';

import { useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { Button } from '@/components/ui/button';

interface CheckoutButtonProps {
  priceId: string;
  label: string;
  className?: string;
}

export function CheckoutButton({ priceId, label, className }: CheckoutButtonProps) {
  const { isSignedIn } = useUser();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    if (!isSignedIn) {
      window.location.href = '/sign-in?redirect_url=' + encodeURIComponent(window.location.href);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/stripe/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId }),
      });
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
