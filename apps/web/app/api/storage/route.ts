import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * What Telar is keeping on disk, by category — the Storage pane's one read.
 *
 * SLOW ON A COLD ENGINE AND THAT IS EXPECTED: the first call of an engine's
 * life walks the whole store, seconds on a large one. Afterwards the engine
 * serves the measurement it already took, carrying the moment it was taken, and
 * `?refresh=1` is what asks for a new walk. Nothing polls this — see #629.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return Response.json(await (await engineClient()).storage(refresh ? { refresh: true } : {}));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
