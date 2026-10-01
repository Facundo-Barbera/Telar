import { engineClient, engineRoute } from "@/platform/engine/server";
import { RELEASABLE_STATES, type ReleasableState, type WorktreeReclaimItem } from "@telar/engine-client";

/** Refusals are the payload, not an error status: one refused checkout must not discard the others' outcomes. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = engineRoute(async (request: Request) => {
  const body = (await request.json()) as { items?: WorktreeReclaimItem[]; state?: string };
  const client = await engineClient();
  if ((RELEASABLE_STATES as readonly string[]).includes(body.state ?? "")) return Response.json(await client.releaseWorktreeState(body.state as ReleasableState));
  return Response.json(await client.reclaimWorktrees(body.items ?? []));
});
