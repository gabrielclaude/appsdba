export const runtime = "nodejs";

export function GET() {
  const pubKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  return Response.json({
    ok: true,
    clerk_pub_key_set: !!pubKey,
    clerk_pub_key_prefix: pubKey?.slice(0, 10) ?? "not set",
  });
}
