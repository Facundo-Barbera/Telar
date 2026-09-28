import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string; method: string[] }> };

/** One door to the session's LaTeX — `latex/<method>` forwarded verbatim. */
export async function POST(request: Request, context: Context) {
  try {
    const { sessionId, method } = await context.params;
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).latex(sessionId, method.join("/"), body));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
