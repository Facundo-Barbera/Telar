import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * THE AGENT'S WAKE INBOX — issue #541, section A.
 *
 * What a completion on a subscribed session writes now that it no longer starts
 * an Agent turn. The section above the composer asks with `unread=1`; without it
 * this pages the whole inbox, which is what a "show everything" disclosure would
 * want.
 *
 * `after` AND `limit` ARE PASSED THROUGH AS TYPED, not re-validated — the
 * engine clamps both and refuses what it cannot read, and a second set of bounds
 * here would be a second thing to keep in step with the one that actually pages.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const after = url.searchParams.get("after");
    const limit = url.searchParams.get("limit");
    const unread = url.searchParams.get("unread");
    return Response.json(
      await (await engineClient()).agentInbox({
        ...(after === null ? {} : { after: Number(after) }),
        ...(limit === null ? {} : { limit: Number(limit) }),
        ...(unread === "1" || unread === "true" ? { unreadOnly: true } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
