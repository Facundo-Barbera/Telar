import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The project twin of the session raw route — one file's bytes out of the
 * project's own checkout, for the pre-session canvas. Same fence, same
 * `no-store` reasoning: a workspace file changes under its own name.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const target = new URL(request.url).searchParams.get("path");
    if (!target) return Response.json({ error: { code: "invalid_request", message: "a file path is required" } }, { status: 400 });
    const { data, contentType } = await (await engineClient()).projectFileBytes(projectId, target);
    return new Response(new Uint8Array(data).buffer as ArrayBuffer, {
      headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
