import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The project's icon, proxied from the engine as bytes.
 *
 * Cached IMMUTABLY: `Project.icon` is a content-derived key the client appends
 * as `?v=`, so a changed file gets a changed URL and this response never needs
 * revalidating. The query parameter itself is not read — it exists purely to
 * make the browser cache honest.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const icon = await (await engineClient()).projectIcon(projectId);
    return new Response(new Uint8Array(icon.data), {
      status: 200,
      headers: {
        "content-type": icon.contentType,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
