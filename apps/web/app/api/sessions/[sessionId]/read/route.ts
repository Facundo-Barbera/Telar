import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    const input = await requestObject(request);
    return Response.json(await (await engineClient()).markSessionRead(sessionId, requiredString(input.runId, "run id")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
