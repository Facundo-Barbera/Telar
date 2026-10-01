import { engineClient, engineRoute } from "@/platform/engine/server";

/** Re-cuts each worktree under `from` at the current location; git is never forced, so a refused one stays where it was. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = engineRoute(async (request: Request) => {
  const body = (await request.json()) as { from?: string };
  return Response.json(await (await engineClient()).moveWorktrees(body.from ?? ""));
});
