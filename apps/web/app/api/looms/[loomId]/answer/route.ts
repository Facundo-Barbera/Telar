import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

/**
 * Answer a loom parked on a question — the bottom of the escalation ladder,
 * where the only thing that unblocks the work is a human sentence. An empty
 * answer is refused here rather than unparking the loom with nothing to go on.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).answerLoom(loomId, requiredString(body.answer, "answer")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
