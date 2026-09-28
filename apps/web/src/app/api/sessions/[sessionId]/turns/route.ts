import {
  requestObject,
  requiredString,
  engineClient,
  engineErrorResponse,
} from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const [{ sessionId }, body] = await Promise.all([context.params, requestObject(request)]);
    const result = await (await engineClient()).submitTurn(sessionId, {
      runId: requiredString(body.runId, "Run id"),
      // A STRING, NOT NECESSARILY WORDS: an image-only message sends "". Whether
      // the turn has anything to say is the engine's call (`turnHasContent`),
      // made once it knows what the attachments are.
      input: typeof body.input === "string" ? body.input : requiredString(body.input, "Turn input"),
      // Both forwarded unvalidated: the engine parses `model` against
      // `TurnModelSelection` and resolves each attachment id against what it
      // actually stored. A second copy of either check here could only disagree
      // with the first.
      ...(body.model === undefined ? {} : { model: body.model as never }),
      ...(Array.isArray(body.attachments) ? { attachments: body.attachments as string[] } : {}),
    });
    return Response.json(result, { status: result.replayed ? 200 : 202 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
