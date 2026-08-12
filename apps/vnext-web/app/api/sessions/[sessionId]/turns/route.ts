import {
  requestObject,
  requiredString,
  vnextEngine,
  vnextErrorResponse,
} from "@/lib/vnext/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const [{ sessionId }, body] = await Promise.all([context.params, requestObject(request)]);
    const result = await (await vnextEngine()).submitTurn(sessionId, {
      runId: requiredString(body.runId, "Run id"),
      text: requiredString(body.text, "Turn text"),
    });
    return Response.json(result, { status: result.replayed ? 200 : 202 });
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
