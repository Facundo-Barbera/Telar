import { engineClient, engineRoute } from "@/platform/engine/server";

/** Sweep now with the current switches. Answers when the sweep is done. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = engineRoute(async () => {
  return Response.json(await (await engineClient()).runCleanup());
});
