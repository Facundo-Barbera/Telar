import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * How the sidebar bands its list — the auto-settle window, and whether there is
 * one at all.
 *
 * ENVIRONMENT-SCOPED, like the MCP registry beside it, and for the sharper
 * version of the same reason: this decides which band EVERY session lands in,
 * so a per-browser copy would show the desktop shell and a browser tab two
 * different inboxes off one engine.
 *
 * THE WINDOW IS FORWARDED UNVALIDATED. The engine holds the bound (1..90, or
 * `null` for no clock) next to the schema that states it; re-checking here
 * would be a second copy of a rule that could disagree with the first.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).inboxPolicy());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).setInboxPolicy({
        // `null` IS THE OFF SWITCH and `undefined` is "leave it alone", so the
        // key's presence is the question — not its truthiness.
        ...("autoSettleAfterDays" in body ? { autoSettleAfterDays: body.autoSettleAfterDays as number | null } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
