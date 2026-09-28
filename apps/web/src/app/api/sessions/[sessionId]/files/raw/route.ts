import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

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

export async function GET(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const target = new URL(request.url).searchParams.get("path");
    if (!target) return Response.json({ error: { code: "invalid_request", message: "a file path is required" } }, { status: 400 });
    const { data, contentType } = await (await engineClient()).sessionFileBytes(sessionId, target);
    return new Response(new Uint8Array(data).buffer as ArrayBuffer, {
      headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
