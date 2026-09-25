import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * What Telar is keeping on disk, by category — the Storage pane's one read.
 *
 * The first call of an engine's life walks the store's own categories; the
 * checkouts are sized in the background and their row says `measuring` until
 * they settle. Afterwards the engine serves what it already took, carrying the
 * moment it was taken, and `?refresh=1` asks for a new walk. Only a pane with a
 * `measuring` row asks again, and only until it settles — see #629.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    // The browser's hang-up travels on to the engine rather than leaving this
    // hop waiting on an answer nobody will read.
    return Response.json(await (await engineClient()).storage({ ...(refresh ? { refresh: true } : {}), signal: request.signal }));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
