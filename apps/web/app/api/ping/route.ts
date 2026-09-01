import pkg from "../../../package.json" with { type: "json" };

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Unauthenticated reachability: the tailscale serve probe and the iOS
 * pre-pairing connectivity check both need a route that answers strangers,
 * and this is the only one that may.
 *
 * Still information-free about STATE (no daemon id, no device names, no
 * paths) — but it carries the version signature, deliberately: a version
 * string is not a secret, and pre-pairing is exactly when a client needs to
 * diagnose skew. `proto` is the pairing-protocol number; bump it only on a
 * REAL break. Clients treat a missing proto as 1 (an older cockpit).
 */
export function GET() {
  return Response.json(
    { ok: true, proto: 1, appVersion: pkg.version },
    { headers: { "cache-control": "no-store" } },
  );
}
