import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

/**
 * A project's issues and pull requests.
 *
 * A NETWORK READ, unlike every other route in this adapter — it goes out to
 * GitHub through the `gh` CLI. The engine caches it for thirty seconds and
 * `?refresh=1` is the only way past that cache; this route forwards the flag
 * rather than deciding, so the cache policy lives in one place.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return Response.json(await (await vnextEngine()).projectGitHub(projectId, { refresh }));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
