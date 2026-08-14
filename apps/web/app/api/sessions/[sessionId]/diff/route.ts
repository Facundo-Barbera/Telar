import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The session's review — what it has done to the repository since it started.
 *
 * `?path=` NARROWS IT TO ONE FILE'S PATCH. The list is polled and a patch is
 * opened one row at a time, so carrying every patch on the list would put a
 * megabyte on a fifteen-second timer for content nobody has asked to see. The
 * path is fenced inside the session's workspace by the ENGINE, not here — an
 * in-process caller must not be able to walk past a check that only ran on the
 * socket.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const url = new URL(request.url);
    const engine = await engineClient();
    const target = url.searchParams.get("path");
    if (target) {
      return Response.json(await engine.sessionFilePatch(sessionId, target, { untracked: url.searchParams.get("untracked") === "1" }));
    }
    return Response.json(await engine.sessionDiff(sessionId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
