import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/posts/(.*)',
  '/category/(.*)',
  '/pricing',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks/(.*)',
]);

export default clerkMiddleware((auth, req) => {
  // All routes are public — gating is enforced in each Server Component.
  // This proxy only injects Clerk session context.
  void auth;
  void req;
  void isPublicRoute;
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)'],
};
