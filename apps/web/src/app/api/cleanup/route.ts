import type { CleanupPolicy } from "@telar/engine-client";
import { engineClient, engineRoute } from "@/platform/engine/server";

/**
 * The automatic cleanup's switches and its last result — Settings → Storage.
 * PUT takes a partial policy and answers with the whole state.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async () => {
  return Response.json(await (await engineClient()).cleanup());
});

export const PUT = engineRoute(async (request: Request) => {
  const patch = (await request.json()) as Partial<CleanupPolicy>;
  return Response.json(await (await engineClient()).setCleanupPolicy(patch));
});
