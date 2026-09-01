export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Unauthenticated reachability, deliberately information-free: the tailscale
 * serve probe and the iOS pre-pairing connectivity check both need a route
 * that answers strangers, and this is the only one that may.
 */
export function GET() {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
