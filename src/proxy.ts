import { NextResponse, type NextRequest } from 'next/server';

const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export async function proxy(request: NextRequest) {
  if (!clerkEnabled) return NextResponse.next();

  const { clerkMiddleware, createRouteMatcher } = await import('@clerk/nextjs/server');

  const isAdminRoute = createRouteMatcher(['/admin(.*)']);
  const isProtectedRoute = createRouteMatcher(['/account(.*)']);

  return clerkMiddleware(async (auth, req) => {
    const { userId } = await auth();

    if (isAdminRoute(req) && !userId) {
      const url = new URL('/sign-in', req.url);
      url.searchParams.set('redirect_url', req.url);
      return NextResponse.redirect(url);
    }

    if (isProtectedRoute(req) && !userId) {
      const url = new URL('/sign-in', req.url);
      url.searchParams.set('redirect_url', req.url);
      return NextResponse.redirect(url);
    }
  })(request, {} as any);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
