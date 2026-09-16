import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * THE BUILT-IN AGENT — whether this Mac has one, which thread it is on, and the
 * one approval it may be parked on (#531).
 *
 * MACHINE-SCOPED, like the session defaults and the inbox rule beside it and for
 * the same reason: remote web, the desktop shell and a paired phone read one
 * engine, and a per-client copy would put the entry in one rail and not the
 * others.
 *
 * FORWARDED UNVALIDATED, also like those. The shape lives beside the schema in
 * the engine's `agent/store.ts`, and a second copy of it at this seam could
 * disagree with the one that actually writes the document.
 *
 * THE CREDENTIAL RIDES THE ANSWER — which RUNG the Agent's OpenCode Go key came
 * from, never the key (`agent/credentials.ts`). Forwarded whole for the same
 * reason as the rest: the pane that reads this is the pane that decides between
 * a field and a setup prompt, and a second request would let the two describe
 * different instants.
 *
 * THE RAIL DOES NOT CALL THIS. It reads `agent: { enabled }` off
 * `/api/sessions/live`, which it already polls; this route is the settings
 * pane's read and its write, and the Agent screen's first read.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).agent());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).setAgent({
        // By PRESENCE, like every other patch here: a client naming only a
        // model must not also be re-deciding the switch — and a `reset` that
        // rode along by default would archive a conversation nobody asked to
        // lose.
        ...("enabled" in body ? { enabled: body.enabled as boolean } : {}),
        ...("model" in body ? { model: body.model as string } : {}),
        // The composer's other two pills (#539). Same presence rule: a client
        // setting an effort must not also be re-deciding who answers approvals.
        ...("effort" in body ? { effort: body.effort as string } : {}),
        ...("access" in body ? { access: body.access as string } : {}),
        ...("reset" in body ? { reset: body.reset as boolean } : {}),
        // WRITE-ONLY. It goes down and never comes back: the answer says which
        // rung answered and nothing else. See `EngineClient.setAgent`.
        ...("apiKey" in body ? { apiKey: body.apiKey as string } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
