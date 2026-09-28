import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import type { WorktreeReclaimItem } from "@telar/engine-client";

/**
 * Give checkouts back — issue #671, and the second destructive thing on the
 * Storage pane.
 *
 * IT ARCHIVES SESSIONS, and that is the fact the UI must lead with. A checkout
 * held by a settled session is released by putting that session down: settling
 * deliberately does not release one ("a settled session's checkout is still the
 * thing it would resume into") and nothing re-cuts a missing worktree, so
 * deleting the directory under a live record would trade invisible orphans for
 * invisible broken sessions. A checkout nothing claims has no session to end,
 * so the directory goes.
 *
 * REFUSALS ARE THE PAYLOAD, NOT AN ERROR STATUS. A press over six checkouts
 * where one has since been claimed by a working session is five successes and
 * one honest refusal; a 409 would discard the five.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { items?: WorktreeReclaimItem[] };
    return Response.json(await (await engineClient()).reclaimWorktrees(body.items ?? []));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
