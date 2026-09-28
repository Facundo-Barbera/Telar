/**
 * The cockpit's half of the run door, forwarded to the engine.
 *
 * IT HOLDS NO DECISIONS: which verb serves which tail is the table in
 * `lib/run/route-map.ts`, so the mapping is tested without a server. Refusals
 * pass through untranslated — `conflict` is what the panel branches on.
 */
import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";
import { RunRouteRefusal, serveRunRequest, type RunEngineVerbs } from "@/lib/run/route-map";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; tail: string[] }> };

async function serve(request: Request, context: Context, method: "GET" | "POST" | "DELETE"): Promise<Response> {
  try {
    const { sessionId, tail } = await context.params;
    const client = (await engineClient()) as unknown as RunEngineVerbs;
    return Response.json(
      await serveRunRequest(client, method, {
        sessionId,
        tail,
        body: method === "GET" || method === "DELETE" ? {} : await requestObject(request),
        query: new URL(request.url).searchParams,
      }),
    );
  } catch (error) {
    if (error instanceof RunRouteRefusal) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    return engineErrorResponse(error);
  }
}

export const GET = (request: Request, context: Context) => serve(request, context, "GET");
export const POST = (request: Request, context: Context) => serve(request, context, "POST");
export const DELETE = (request: Request, context: Context) => serve(request, context, "DELETE");
