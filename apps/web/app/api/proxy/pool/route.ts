import { proxyPool, managementBreakerState } from "@telar/core";

export const dynamic = "force-dynamic";

// THE CREDENTIAL POOL — the one route that spends a management auth attempt.
//
// It is a POST rather than a GET on purpose. Management auth has a hardcoded
// lockout in which a failed attempt, and every attempt made while locked out,
// extends the ban; a GET invites prefetching, link-preview fetches, retries on
// refresh, and a browser deciding for itself to ask twice. A POST is made only
// when something meant it.
//
// `proxyPool` clears the breaker before its single call, so each click is one
// fresh attempt and no more. If it fails, the breaker trips and every later
// call short-circuits without touching the network until the next click.
export async function POST() {
  const { upstreams, error } = await proxyPool();
  return Response.json({ upstreams, error, management: managementBreakerState() });
}
