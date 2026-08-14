import {
  optionalString,
  requestObject,
  engineClient,
  engineErrorResponse,
} from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const [{ sessionId }, body] = await Promise.all([context.params, requestObject(request)]);
    return Response.json(await (await engineClient()).stopTurn(sessionId, optionalString(body.runId, "Run id")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
