import { engineClient, engineRoute } from "@/platform/engine/server";

/**
 * Computer use, measured on request — the engine runs one real read-only call
 * through cua-driver, so this is slow by design (a subprocess round trip) and
 * never cached: the whole point is the CURRENT answer, and the engine gives
 * sessions the desktop tools only after a probe answered granted.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async () => {
  return Response.json(await (await engineClient()).computerUseStatus());
});
