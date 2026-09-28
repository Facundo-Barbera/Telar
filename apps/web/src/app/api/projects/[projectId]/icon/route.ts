import { engineClient, engineErrorResponse } from "@/platform/engine/server";

/** Immutable: `?v=` is the content-derived `Project.icon`; `?format=png` is for clients that cannot decode SVG. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const png = new URL(request.url).searchParams.get("format") === "png";
    const icon = await (await engineClient()).projectIcon(projectId, png ? { format: "png" } : {});
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
