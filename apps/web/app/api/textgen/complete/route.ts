import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * One structured completion from the text-generation harness — the title job's
 * subprocess, opened up to callers that bring their own JSON schema.
 *
 * ENGINE-SCOPED like the policy route beside it, and for a stronger reason: the
 * completion runs as the driver's BUILT-IN instance under the environment's
 * stored policy, so which harness answers is a property of this machine rather
 * than of the window that asked.
 *
 * FORWARDED UNVALIDATED, same reasoning as the policy route: the prompt cap,
 * the schema shape, and the model bound all live next to the code that spawns
 * the child, and a second copy of them here would drift on the first change.
 *
 * SLOW AND FALLIBLE. A cold harness start plus a completion; a harness that
 * refuses or times out comes back as 502 `textgen_failed`, never as an empty
 * success. Callers must survive that.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).completeStructured({
        prompt: body.prompt as string,
        schema: body.schema as Record<string, unknown>,
        ...("model" in body ? { model: body.model as string } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
