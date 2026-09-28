import { parseDiffBaseQuery, parseFilePatchQuery } from "@telar/engine-client";

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
 *
 * THE QUERY IS PARSED BY THE CONTRACT'S PARSER, NOT BY HAND — this adapter is
 * the layer that dropped `ignoreWhitespace` in #694 while every layer either
 * side of it was correct, which is the same failure `forgeQuery` documents for
 * the GitHub filter. Listing the parameters here is how that happens; parsing
 * them with the same function the client builds them with is how it stops.
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
      return Response.json(await engine.sessionFilePatch(sessionId, target, parseFilePatchQuery(url.searchParams)));
    }
    return Response.json(await engine.sessionDiff(sessionId, parseDiffBaseQuery(url.searchParams)));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
