import { optionalString, requestObject, engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export const GET = engineRoute(async (_request: Request, context: Context) => {
  const { projectId } = await context.params;
  const { sessions } = await (await engineClient()).listSessions(projectId);
  return Response.json({ sessions });
});

export const POST = engineRoute(async (request: Request, context: Context) => {
  const [{ projectId }, body] = await Promise.all([context.params, requestObject(request)]);
  const result = await (await engineClient()).createSession({
    ...(body.draft === true ? { draft: true } : {}),
    id: optionalString(body.id, "Session id"),
    projectId,
    title: optionalString(body.title, "Session title"),
    // Validated in the engine against the contract's own lists, so this route
    // and an in-process caller refuse the same set.
    ...(body.driver === "claude" || body.driver === "codex" || body.driver === "opencode" ? { driver: body.driver } : {}),
    ...(body.envMode === "local" || body.envMode === "worktree" ? { envMode: body.envMode } : {}),
    // The base-ref picker's knobs — validated in the engine (store +
    // worktree.ts) so every caller refuses the same names.
    ...(typeof body.baseRef === "string" && body.baseRef ? { baseRef: body.baseRef } : {}),
    ...(typeof body.branchName === "string" && body.branchName ? { branchName: body.branchName } : {}),
  });
  return Response.json(result, { status: 201 });
});
