import { NextRequest, NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';

export async function POST(request: NextRequest) {
  const { sessionClaims, userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const callerRole = (sessionClaims?.metadata as { role?: string } | undefined)?.role;
  if (callerRole !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { clerkUserId, role } = await request.json();
  if (!clerkUserId || !['admin', 'user'].includes(role)) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  const client = await clerkClient();
  await client.users.updateUserMetadata(clerkUserId, {
    publicMetadata: { role: role === 'admin' ? 'admin' : null },
  });

  return NextResponse.json({ success: true });
}
