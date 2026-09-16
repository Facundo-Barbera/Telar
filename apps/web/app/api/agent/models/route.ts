import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * WHAT OPENCODE GO SERVES THE AGENT — the model picker's list (#531).
 *
 * IT FAILS SOFT, and that is the whole contract: a Go that is unreachable, or a
 * machine with no key yet, answers an EMPTY list and a `message` rather than an
 * error. So this route forwards the answer whole and never turns a `message`
 * into a failure — the pane offers what it can and says why, which is the order
 * people actually do this in. The setting gets opened before the key is pasted
 * at least as often as after, and a picker that 500s in that state would look
 * broken rather than empty.
 *
 * SEPARATE FROM `/api/agent` because it is a LIST, not this machine's state:
 * it costs a network call to another service, and the settings pane reads it
 * once when it opens rather than on every write that returns the document.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).agentModels());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
