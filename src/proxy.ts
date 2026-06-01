import { NextResponse, type NextRequest } from 'next/server';

// Clerk is only activated when keys are configured
const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export async function proxy(request: NextRequest) {
  if (!clerkEnabled) return NextResponse.next();

  const { clerkMiddleware, createRouteMatcher } = await import('@clerk/nextjs/server');

  const isPublicRoute = createRouteMatcher([
    '/',
    '/posts/(.*)',
    '/category/(.*)',
    '/pricing',
    '/sign-in(.*)',
    '/sign-up(.*)',
    '/api/webhooks/(.*)',
  ]);

  return clerkMiddleware((auth, req) => {
    void auth; void req; void isPublicRoute;
  })(request, {} as any);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)'],
};
