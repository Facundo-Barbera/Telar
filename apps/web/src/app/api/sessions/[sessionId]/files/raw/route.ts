import { engineClient, engineRoute, invalidRequest, bytesResponse } from "@/platform/engine/server";

/**
 * One session file's BYTES — what the panel's media viewers (image, PDF,
 * audio, video) point their `src` at. Fenced inside the session's checkout by
 * the engine; refused past the engine's raw ceiling rather than truncated.
 * `no-store` because, unlike an attachment, a workspace file changes under
 * its own name.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export const GET = engineRoute(async (request: Request, context: Context) => {
  const { sessionId } = await context.params;
  const target = new URL(request.url).searchParams.get("path");
  if (!target) throw invalidRequest("a file path is required");
  const { data, contentType } = await (await engineClient()).sessionFileBytes(sessionId, target);
  return bytesResponse({ data, contentType });
});
