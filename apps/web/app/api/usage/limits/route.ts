import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * What the configured hubs currently report — the Limits section's one read.
 *
 * `?refresh=1` WAITS for a fresh read of every hub; without it the engine
 * serves its cached snapshot straight away and refreshes behind the answer, so
 * opening the page never blocks on somebody else's network.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return Response.json(await (await engineClient()).usageLimits(refresh ? { refresh: true } : {}));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
