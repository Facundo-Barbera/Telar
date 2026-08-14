import { parseForgeQuery } from "@telar/engine-client";
import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * A project's issues and pull requests.
 *
 * A NETWORK READ, unlike every other route in this adapter — it goes out to
 * GitHub through the `gh` CLI. The engine caches it and `?refresh=1` is the only
 * way past that cache; this route forwards the flag rather than deciding, so the
 * cache policy lives in one place.
 *
 * THE FILTERS ARE PARSED BY THE CONTRACT'S OWN PARSER, not by hand here. This route
 * used to forward `refresh` and nothing else, which silently discarded every filter:
 * choosing a milestone made a request with the milestone in it, typechecked at every
 * layer, passed every test, and came back with every issue in the repository. A
 * proxy that re-implements the query string it is proxying is a place for exactly
 * that to happen — see `parseForgeQuery`.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const filters = parseForgeQuery(new URL(request.url).searchParams);
    return Response.json(await (await engineClient()).projectGitHub(projectId, filters));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
