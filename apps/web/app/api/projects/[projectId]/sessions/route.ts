import {
  optionalString,
  requestObject,
  engineClient,
  engineErrorResponse,
} from "@/lib/engine/engine-server";
import { loomOwnedSessionIds } from "@/lib/looms/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const { sessions } = await (await engineClient()).listSessions(projectId);
    // DETACHMENT (docs/loom-model-v1.md): sessions a loom owns — origin and
    // threads — do not exist on the ordinary surface. They are reachable only
    // through the loom's room. This route is the one list every ordinary
    // surface (sidebar, project pages) reads, so subtracting here is the
    // whole enforcement.
    const owned = loomOwnedSessionIds();
    return Response.json({ sessions: sessions.filter((session) => !owned.has(session.id)) });
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
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
  } catch (error) {
    return engineErrorResponse(error);
  }
}
