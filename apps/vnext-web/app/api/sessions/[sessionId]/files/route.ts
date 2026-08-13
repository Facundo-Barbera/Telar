import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

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

export async function GET(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const target = new URL(request.url).searchParams.get("path");
    const engine = await vnextEngine();
    if (target) return Response.json(await engine.sessionFile(sessionId, target));
    return Response.json(await engine.sessionFiles(sessionId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}

/**
 * Save an edited file.
 *
 * The body carries `expectedSha256` — the hash the editor read — and the ENGINE
 * decides whether disk still matches. A refusal comes back 200 with
 * `written: false`; this hop adds nothing but the parameter check, because a
 * precondition enforced here would not protect an in-process caller.
 */
export async function PUT(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const target = new URL(request.url).searchParams.get("path");
    if (!target) return Response.json({ error: { code: "invalid_request", message: "a file path is required" } }, { status: 400 });
    const body = (await request.json()) as { text?: unknown; expectedSha256?: unknown };
    if (typeof body.text !== "string" || typeof body.expectedSha256 !== "string") {
      return Response.json({ error: { code: "invalid_request", message: "text and expectedSha256 are required" } }, { status: 400 });
    }
    const engine = await vnextEngine();
    return Response.json(await engine.writeSessionFile(sessionId, target, body.text, body.expectedSha256));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
