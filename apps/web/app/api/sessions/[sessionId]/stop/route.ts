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
    const client = await engineClient();
    /**
     * `scope: "session"` is the Stop button — end the live turn and settle
     * what was queued behind it. Absent is the one-turn stop. Validated here
     * as well as at the engine so a typo is refused at the edge rather than
     * quietly stopping something other than what was meant.
     */
    const scope = optionalString(body.scope, "Scope");
    if (scope !== undefined && scope !== "session") throw new Error('Scope must be "session" when given.');
    if (scope === "session") return Response.json(await client.stopSession(sessionId));
    return Response.json(await client.stopTurn(sessionId, optionalString(body.runId, "Run id")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
