import { engineClient, engineRoute, invalidRequest } from "@/platform/engine/server";

/**
 * The session's own checkout, as a file list — its worktree when it cut one, so
 * the tree describes the directory the agent is actually writing in rather than
 * whatever the project root happens to hold.
 *
 * `?path=` narrows to one file's text. Fenced by the engine; see the project
 * route beside this one.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export const GET = engineRoute(async (request: Request, context: Context) => {
  const { sessionId } = await context.params;
  const target = new URL(request.url).searchParams.get("path");
  const engine = await engineClient();
  if (target) return Response.json(await engine.sessionFile(sessionId, target));
  return Response.json(await engine.sessionFiles(sessionId));
});

/**
 * Save an edited file.
 *
 * The body carries `expectedSha256` — the hash the editor read — and the ENGINE
 * decides whether disk still matches. A refusal comes back 200 with
 * `written: false`; this hop adds nothing but the parameter check, because a
 * precondition enforced here would not protect an in-process caller.
 */
export const PUT = engineRoute(async (request: Request, context: Context) => {
  const { sessionId } = await context.params;
  const target = new URL(request.url).searchParams.get("path");
  if (!target) throw invalidRequest("a file path is required");
  const body = (await request.json()) as { text?: unknown; expectedSha256?: unknown };
  if (typeof body.text !== "string" || typeof body.expectedSha256 !== "string") {
    throw invalidRequest("text and expectedSha256 are required");
  }
  const engine = await engineClient();
  return Response.json(await engine.writeSessionFile(sessionId, target, body.text, body.expectedSha256));
});
